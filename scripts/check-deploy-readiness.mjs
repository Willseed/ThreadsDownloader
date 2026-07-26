import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

export { resolvePathWithinRoot } from './path-containment.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultBundleRoot = resolve(repositoryRoot, 'dist/web/browser');

const pendingLegalStatusPatterns = Object.freeze([
  /data-legal-status\s*=\s*["']pending[-_a-z0-9]*["']/iu,
  /["']data-legal-status["']\s*[:,]\s*["']pending[-_a-z0-9]*["']/iu,
]);
const approvedLegalStatusPatterns = Object.freeze([
  /data-legal-status\s*=\s*["']approved-for-production["']/iu,
  /["']data-legal-status["']\s*[:,]\s*["']approved-for-production["']/iu,
]);

export const DEPLOY_READINESS_RULES = Object.freeze({
  argumentInvalid: 'DEPLOY_ARGUMENT_INVALID',
  approvalMissing: 'DEPLOY_LEGAL_STATUS_APPROVAL_MISSING',
  bundleEmpty: 'DEPLOY_BUNDLE_EMPTY',
  bundleMissing: 'DEPLOY_BUNDLE_MISSING',
  bundleNotDirectory: 'DEPLOY_BUNDLE_NOT_DIRECTORY',
  bundleOutsideRoot: 'DEPLOY_BUNDLE_OUTSIDE_ALLOWED_ROOT',
  entryOutsideRoot: 'DEPLOY_ENTRY_OUTSIDE_BUNDLE_ROOT',
  entryReadFailed: 'DEPLOY_ENTRY_READ_FAILED',
  entryStatFailed: 'DEPLOY_ENTRY_STAT_FAILED',
  entrySymlink: 'DEPLOY_ENTRY_SYMLINK_FORBIDDEN',
  entryType: 'DEPLOY_ENTRY_TYPE_FORBIDDEN',
  legalPending: 'DEPLOY_LEGAL_STATUS_PENDING',
});

function classifyLegalStatus(bytes) {
  const contents = bytes.toString('latin1');
  return {
    approved: approvedLegalStatusPatterns.some((pattern) => pattern.test(contents)),
    pending: pendingLegalStatusPatterns.some((pattern) => pattern.test(contents)),
  };
}

async function inspectEntry(bundleRoot, entryPath, state) {
  const containedEntry = resolve(entryPath);
  const entryFromRoot = relative(resolve(bundleRoot), containedEntry);
  if (isAbsolute(entryFromRoot) || entryFromRoot.split(sep).includes('..')) {
    state.rules.add(DEPLOY_READINESS_RULES.entryOutsideRoot);
    return;
  }

  let stat;
  try {
    stat = await lstat(containedEntry);
  } catch {
    state.rules.add(DEPLOY_READINESS_RULES.entryStatFailed);
    return;
  }

  if (stat.isSymbolicLink()) {
    state.rules.add(DEPLOY_READINESS_RULES.entrySymlink);
    return;
  }

  let canonicalEntry;
  try {
    canonicalEntry = await realpath(containedEntry);
  } catch {
    state.rules.add(DEPLOY_READINESS_RULES.entryReadFailed);
    return;
  }
  const canonicalFromRoot = relative(resolve(bundleRoot), canonicalEntry);
  if (isAbsolute(canonicalFromRoot) || canonicalFromRoot.split(sep).includes('..')) {
    state.rules.add(DEPLOY_READINESS_RULES.entryOutsideRoot);
    return;
  }

  if (stat.isDirectory()) {
    let entries;
    try {
      entries = await readdir(canonicalEntry);
    } catch {
      state.rules.add(DEPLOY_READINESS_RULES.entryReadFailed);
      return;
    }
    entries.sort((left, right) => left.localeCompare(right, 'en'));
    await Promise.all(
      entries.map((entry) => inspectEntry(bundleRoot, resolve(canonicalEntry, entry), state)),
    );
    return;
  }
  if (!stat.isFile()) {
    state.rules.add(DEPLOY_READINESS_RULES.entryType);
    return;
  }

  state.fileCount += 1;
  try {
    const legalStatus = classifyLegalStatus(await readFile(canonicalEntry));
    state.approved ||= legalStatus.approved;
    if (legalStatus.pending) {
      state.rules.add(DEPLOY_READINESS_RULES.legalPending);
    }
  } catch {
    state.rules.add(DEPLOY_READINESS_RULES.entryReadFailed);
  }
}

export async function checkDeployReadiness(
  bundleRoot = defaultBundleRoot,
  allowedDirectory = bundleRoot,
) {
  const allowedRoot = resolve(allowedDirectory);
  const root = resolve(bundleRoot);
  const rootFromAllowed = relative(allowedRoot, root);
  if (isAbsolute(rootFromAllowed) || rootFromAllowed.split(sep).includes('..')) {
    return [DEPLOY_READINESS_RULES.bundleOutsideRoot];
  }

  let stat;
  try {
    stat = await lstat(root);
  } catch {
    return [DEPLOY_READINESS_RULES.bundleMissing];
  }
  if (stat.isSymbolicLink()) {
    return [DEPLOY_READINESS_RULES.entrySymlink];
  }
  if (!stat.isDirectory()) {
    return [DEPLOY_READINESS_RULES.bundleNotDirectory];
  }

  let allowedRealRoot;
  let bundleRealRoot;
  try {
    [allowedRealRoot, bundleRealRoot] = await Promise.all([realpath(allowedRoot), realpath(root)]);
  } catch {
    return [DEPLOY_READINESS_RULES.bundleMissing];
  }
  const canonicalFromAllowed = relative(allowedRealRoot, bundleRealRoot);
  if (isAbsolute(canonicalFromAllowed) || canonicalFromAllowed.split(sep).includes('..')) {
    return [DEPLOY_READINESS_RULES.bundleOutsideRoot];
  }
  const canonicalRoot = bundleRealRoot;

  const state = { approved: false, fileCount: 0, rules: new Set() };
  await inspectEntry(canonicalRoot, canonicalRoot, state);
  if (state.fileCount === 0) {
    state.rules.add(DEPLOY_READINESS_RULES.bundleEmpty);
  } else if (!state.approved) {
    state.rules.add(DEPLOY_READINESS_RULES.approvalMissing);
  }
  return [...state.rules].sort((left, right) => left.localeCompare(right, 'en'));
}

async function main() {
  let rules;
  if (process.argv.length === 2) {
    rules = await checkDeployReadiness(defaultBundleRoot);
  } else if (process.argv.length === 3 && process.argv[2] === '.') {
    rules = await checkDeployReadiness(process.cwd());
  } else {
    process.stderr.write(`${DEPLOY_READINESS_RULES.argumentInvalid} <web-bundle>\n`);
    process.exitCode = 1;
    return;
  }

  if (rules.length === 0) {
    return;
  }
  for (const rule of rules) {
    process.stderr.write(`${rule} <web-bundle>\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
