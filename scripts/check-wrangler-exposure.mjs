import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { getNodeValue, parseTree } from 'jsonc-parser';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultConfigPath = resolve(repositoryRoot, 'wrangler.jsonc');

const REQUIRED_SECRETS = Object.freeze([
  'DOWNLOAD_ENCRYPTION_KEY',
  'RESOLVED_MEDIA_GRANT_KEY',
  'SESSION_SIGNING_KEY',
  'TURNSTILE_SECRET',
]);
const REQUIRED_SECRET_ORDER = new Map(REQUIRED_SECRETS.map((name, index) => [name, index]));

const EXPECTED_ASSETS = Object.freeze({
  directory: './dist/web/browser',
  binding: 'ASSETS',
  not_found_handling: 'single-page-application',
  run_worker_first: true,
});
const EXPECTED_BROWSER = Object.freeze({ binding: 'BROWSER' });

const EXPECTED_VAR_KEYS = Object.freeze(['EXPECTED_HOST', 'EXPECTED_ORIGIN', 'TURNSTILE_SITE_KEY']);
const SAFE_TURNSTILE_SITE_KEY = /^[A-Za-z0-9_-]{1,128}$/u;

const FORBIDDEN_EXPOSURE_KEYS = new Set(['route', 'routes', 'customdomain', 'customdomains']);

export const WRANGLER_RULES = Object.freeze({
  read: 'WRANGLER_CONFIG_READ',
  parse: 'WRANGLER_CONFIG_PARSE',
  duplicateKey: 'WRANGLER_DUPLICATE_KEY',
  rootObject: 'WRANGLER_ROOT_OBJECT',
  workersDev: 'WRANGLER_WORKERS_DEV',
  previewUrls: 'WRANGLER_PREVIEW_URLS',
  environment: 'WRANGLER_ENVIRONMENT',
  routeConfiguration: 'WRANGLER_ROUTE_CONFIGURATION',
  name: 'WRANGLER_NAME',
  main: 'WRANGLER_MAIN',
  vars: 'WRANGLER_VARS',
  expectedHost: 'WRANGLER_EXPECTED_HOST',
  expectedOrigin: 'WRANGLER_EXPECTED_ORIGIN',
  turnstileSiteKey: 'WRANGLER_TURNSTILE_SITE_KEY',
  assets: 'WRANGLER_ASSETS',
  browserBinding: 'WRANGLER_BROWSER_BINDING',
  requiredSecrets: 'WRANGLER_REQUIRED_SECRETS',
  secretValue: 'WRANGLER_SECRET_VALUE',
  checkFailed: 'WRANGLER_CHECK_FAILED',
});

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareNames(left, right) {
  return left.localeCompare(right, 'en');
}

function compareRequiredSecrets(left, right) {
  const fallbackOrder = REQUIRED_SECRETS.length;
  return (
    (REQUIRED_SECRET_ORDER.get(left) ?? fallbackOrder) -
    (REQUIRED_SECRET_ORDER.get(right) ?? fallbackOrder)
  );
}

function hasExactProperties(value, expected) {
  if (!isObject(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort(compareNames);
  const expectedKeys = Object.keys(expected).sort(compareNames);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key])
  );
}

function hasDuplicateKey(node) {
  if (node.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string' || keys.has(key)) {
        return true;
      }
      keys.add(key);
      const valueNode = property.children?.[1];
      if (valueNode !== undefined && hasDuplicateKey(valueNode)) {
        return true;
      }
    }
  }
  if (node.type === 'array') {
    return (node.children ?? []).some((child) => hasDuplicateKey(child));
  }
  return false;
}

function normalizedKey(key) {
  return key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
}

function hasForbiddenExposureConfiguration(value) {
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenExposureConfiguration(item));
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_EXPOSURE_KEYS.has(normalizedKey(key)) || hasForbiddenExposureConfiguration(child),
  );
}

function hasUnsafeExposureFlag(value, flag) {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeExposureFlag(item, flag));
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    if (key === flag && child !== false) {
      return true;
    }
    return hasUnsafeExposureFlag(child, flag);
  });
}

function isRequiredSecretPath(path) {
  return (
    path.length === 3 &&
    path[0] === 'secrets' &&
    path[1] === 'required' &&
    typeof path[2] === 'number'
  );
}

function hasSecretValueConfiguration(value, path = []) {
  if (typeof value === 'string') {
    return REQUIRED_SECRETS.includes(value) && !isRequiredSecretPath(path);
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => hasSecretValueConfiguration(item, [...path, index]));
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      REQUIRED_SECRETS.includes(key) || hasSecretValueConfiguration(child, [...path, key]),
  );
}

function hasExactRequiredSecrets(value) {
  if (!isObject(value) || !Object.hasOwn(value, 'required')) {
    return false;
  }
  if (Object.keys(value).length !== 1 || !Array.isArray(value.required)) {
    return false;
  }
  const actual = value.required;
  if (actual.length !== REQUIRED_SECRETS.length || new Set(actual).size !== actual.length) {
    return false;
  }
  return [...actual]
    .sort(compareRequiredSecrets)
    .every((name, index) => name === REQUIRED_SECRETS[index]);
}

function hasExactVars(value) {
  if (!isObject(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort(compareNames);
  const expectedKeys = [...EXPECTED_VAR_KEYS].sort(compareNames);
  return (
    actualKeys.length === EXPECTED_VAR_KEYS.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function bindingViolations(config) {
  const violations = [];
  if (!hasExactProperties(config.assets, EXPECTED_ASSETS)) {
    violations.push(WRANGLER_RULES.assets);
  }
  if (!hasExactProperties(config.browser, EXPECTED_BROWSER)) {
    violations.push(WRANGLER_RULES.browserBinding);
  }
  return violations;
}

function configurationViolations(config) {
  const violations = [];
  if (!Object.hasOwn(config, 'workers_dev') || config.workers_dev !== false) {
    violations.push(WRANGLER_RULES.workersDev);
  }
  if (!Object.hasOwn(config, 'preview_urls') || config.preview_urls !== false) {
    violations.push(WRANGLER_RULES.previewUrls);
  }
  if (hasUnsafeExposureFlag(config, 'workers_dev')) {
    violations.push(WRANGLER_RULES.workersDev);
  }
  if (hasUnsafeExposureFlag(config, 'preview_urls')) {
    violations.push(WRANGLER_RULES.previewUrls);
  }
  if (Object.hasOwn(config, 'env')) {
    violations.push(WRANGLER_RULES.environment);
  }
  if (hasForbiddenExposureConfiguration(config)) {
    violations.push(WRANGLER_RULES.routeConfiguration);
  }
  if (config.name !== 'threads-downloader') {
    violations.push(WRANGLER_RULES.name);
  }
  if (config.main !== 'apps/worker/src/index.ts') {
    violations.push(WRANGLER_RULES.main);
  }
  if (!hasExactVars(config.vars)) {
    violations.push(WRANGLER_RULES.vars);
  }
  if (!isObject(config.vars) || config.vars.EXPECTED_HOST !== 'threads.pylot.dev') {
    violations.push(WRANGLER_RULES.expectedHost);
  }
  if (!isObject(config.vars) || config.vars.EXPECTED_ORIGIN !== 'https://threads.pylot.dev') {
    violations.push(WRANGLER_RULES.expectedOrigin);
  }
  if (
    !isObject(config.vars) ||
    typeof config.vars.TURNSTILE_SITE_KEY !== 'string' ||
    !SAFE_TURNSTILE_SITE_KEY.test(config.vars.TURNSTILE_SITE_KEY)
  ) {
    violations.push(WRANGLER_RULES.turnstileSiteKey);
  }
  violations.push(...bindingViolations(config));
  if (!hasExactRequiredSecrets(config.secrets)) {
    violations.push(WRANGLER_RULES.requiredSecrets);
  }
  if (hasSecretValueConfiguration(config)) {
    violations.push(WRANGLER_RULES.secretValue);
  }
  return [...new Set(violations)];
}

export async function checkWranglerExposure(configPath = defaultConfigPath) {
  let source;
  try {
    source = await readFile(configPath, 'utf8');
  } catch {
    return [WRANGLER_RULES.read];
  }
  if (source.trim().length === 0) {
    return [WRANGLER_RULES.parse];
  }

  const errors = [];
  const tree = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (tree === undefined || errors.length > 0) {
    return [WRANGLER_RULES.parse];
  }
  if (hasDuplicateKey(tree)) {
    return [WRANGLER_RULES.duplicateKey];
  }
  if (tree.type !== 'object') {
    return [WRANGLER_RULES.rootObject];
  }
  const config = getNodeValue(tree);
  if (!isObject(config)) {
    return [WRANGLER_RULES.rootObject];
  }
  return configurationViolations(config);
}

export async function runWranglerExposureCheck(
  configPath = defaultConfigPath,
  errorOutput = process.stderr,
) {
  const violations = await checkWranglerExposure(configPath);
  for (const rule of violations) {
    errorOutput.write(`wrangler.jsonc [${rule}]\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    process.exitCode = await runWranglerExposureCheck();
  } catch {
    process.stderr.write(`wrangler.jsonc [${WRANGLER_RULES.checkFailed}]\n`);
    process.exitCode = 1;
  }
}
