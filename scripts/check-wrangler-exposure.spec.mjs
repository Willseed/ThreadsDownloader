import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkWranglerExposure,
  runWranglerExposureCheck,
  WRANGLER_RULES,
} from './check-wrangler-exposure.mjs';

const REQUIRED_SECRETS = [
  'DOWNLOAD_ENCRYPTION_KEY',
  'RESOLVED_MEDIA_GRANT_KEY',
  'SESSION_SIGNING_KEY',
  'TURNSTILE_SECRET',
];

function validConfig() {
  return {
    name: 'threads-downloader',
    main: 'apps/worker/src/index.ts',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    secrets: { required: [...REQUIRED_SECRETS] },
    vars: {
      EXPECTED_HOST: 'threads.pylot.dev',
      EXPECTED_ORIGIN: 'https://threads.pylot.dev',
      TURNSTILE_SITE_KEY: 'public-fixture-site-key',
    },
    assets: {
      directory: './dist/web/browser',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    },
    browser: { binding: 'BROWSER' },
  };
}

async function withConfig(source, assertion) {
  const directory = await mkdtemp(join(tmpdir(), 'wrangler-gate-'));
  const configPath = join(directory, 'wrangler.jsonc');
  try {
    await writeFile(configPath, source, 'utf8');
    await assertion(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function violationsFor(config) {
  let violations = [];
  await withConfig(JSON.stringify(config), async (configPath) => {
    violations = await checkWranglerExposure(configPath);
  });
  return violations;
}

describe('Wrangler exposure gate', () => {
  it('accepts the production config and JSONC comments with trailing commas', async () => {
    await expect(checkWranglerExposure(resolve('wrangler.jsonc'))).resolves.toEqual([]);
    const source = `${JSON.stringify(validConfig(), null, 2).replace(/\n\}$/u, ',\n}')}\n// safe comment\n`;
    await withConfig(source, async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([]);
    });
  });

  it.each([
    ['missing workers_dev', (config) => delete config.workers_dev, WRANGLER_RULES.workersDev],
    ['enabled workers_dev', (config) => (config.workers_dev = true), WRANGLER_RULES.workersDev],
    ['string workers_dev', (config) => (config.workers_dev = 'false'), WRANGLER_RULES.workersDev],
    ['missing preview_urls', (config) => delete config.preview_urls, WRANGLER_RULES.previewUrls],
    ['enabled preview_urls', (config) => (config.preview_urls = true), WRANGLER_RULES.previewUrls],
    ['named environment block', (config) => (config.env = {}), WRANGLER_RULES.environment],
    [
      'nested exposure override',
      (config) => (config.env = { preview_urls: true }),
      WRANGLER_RULES.previewUrls,
    ],
    ['route property', (config) => (config.route = null), WRANGLER_RULES.routeConfiguration],
    ['empty routes property', (config) => (config.routes = []), WRANGLER_RULES.routeConfiguration],
    [
      'nested custom domain property',
      (config) => (config.env = { production: { custom_domain: false } }),
      WRANGLER_RULES.routeConfiguration,
    ],
  ])('rejects %s', async (_name, mutate, rule) => {
    const config = validConfig();
    mutate(config);
    await expect(violationsFor(config)).resolves.toContain(rule);
  });

  it('rejects a Unicode-escaped route key without scanning strings or comments', async () => {
    const routeSource = JSON.stringify({ ...validConfig(), route: [] }).replace(
      '"route"',
      '"r\\u006fute"',
    );
    await withConfig(routeSource, async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toContain(
        WRANGLER_RULES.routeConfiguration,
      );
    });

    const clean = validConfig();
    clean.fixture_note = 'route';
    await expect(violationsFor(clean)).resolves.toEqual([]);
  });

  it.each([
    ['wrong name', (config) => (config.name = 'fixture-worker'), WRANGLER_RULES.name],
    ['wrong main', (config) => (config.main = 'apps/worker/src/other.ts'), WRANGLER_RULES.main],
    [
      'missing Node compatibility flag',
      (config) => delete config.compatibility_flags,
      WRANGLER_RULES.compatibilityFlags,
    ],
    [
      'wrong Node compatibility flag',
      (config) => (config.compatibility_flags = ['nodejs_compat_v2']),
      WRANGLER_RULES.compatibilityFlags,
    ],
    [
      'extra compatibility flag',
      (config) => config.compatibility_flags.push('nodejs_als'),
      WRANGLER_RULES.compatibilityFlags,
    ],
    [
      'wrong host',
      (config) => (config.vars.EXPECTED_HOST = 'fixture.invalid'),
      WRANGLER_RULES.expectedHost,
    ],
    [
      'wrong origin',
      (config) => (config.vars.EXPECTED_ORIGIN = 'https://fixture.invalid'),
      WRANGLER_RULES.expectedOrigin,
    ],
    [
      'extra production var',
      (config) => (config.vars.API_TOKEN = 'obvious-fixture-value'),
      WRANGLER_RULES.vars,
    ],
    [
      'unsafe public site key',
      (config) => (config.vars.TURNSTILE_SITE_KEY = ''),
      WRANGLER_RULES.turnstileSiteKey,
    ],
    [
      'wrong assets directory',
      (config) => (config.assets.directory = './dist/other'),
      WRANGLER_RULES.assets,
    ],
    [
      'non-boolean run_worker_first',
      (config) => (config.assets.run_worker_first = ['/*']),
      WRANGLER_RULES.assets,
    ],
    [
      'extra assets setting',
      (config) => (config.assets.html_handling = 'none'),
      WRANGLER_RULES.assets,
    ],
  ])('rejects %s', async (_name, mutate, rule) => {
    const config = validConfig();
    mutate(config);
    await expect(violationsFor(config)).resolves.toContain(rule);
  });

  it.each([
    ['missing browser binding', (config) => delete config.browser],
    ['wrong browser binding', (config) => (config.browser = { binding: 'OTHER' })],
    ['remote browser binding', (config) => (config.browser = { binding: 'BROWSER', remote: true })],
    [
      'browser binding with an extra field',
      (config) => (config.browser = { binding: 'BROWSER', fixture: false }),
    ],
    ['non-object browser binding', (config) => (config.browser = 'BROWSER')],
  ])('rejects %s', async (_name, mutate) => {
    const config = validConfig();
    mutate(config);
    await expect(violationsFor(config)).resolves.toContain(WRANGLER_RULES.browserBinding);
  });

  it.each([
    ['missing required name', (config) => config.secrets.required.pop()],
    ['extra required name', (config) => config.secrets.required.push('FIXTURE_SECRET')],
    [
      'duplicate required name',
      (config) => (config.secrets.required[3] = config.secrets.required[0]),
    ],
    ['secret value beside required names', (config) => (config.secrets.fixture = 'fixture-value')],
  ])('rejects %s', async (_name, mutate) => {
    const config = validConfig();
    mutate(config);
    await expect(violationsFor(config)).resolves.toContain(WRANGLER_RULES.requiredSecrets);
  });

  it('rejects secret bindings configured as values outside secrets.required', async () => {
    const keyValue = validConfig();
    keyValue.vars.TURNSTILE_SECRET = 'fixture-value-never-echo';
    await expect(violationsFor(keyValue)).resolves.toContain(WRANGLER_RULES.secretValue);

    const stringValue = validConfig();
    stringValue.fixture_binding = 'SESSION_SIGNING_KEY';
    await expect(violationsFor(stringValue)).resolves.toContain(WRANGLER_RULES.secretValue);
  });

  it('fails closed on unreadable, empty, malformed, duplicate-key, and non-object configs', async () => {
    const missingDirectory = await mkdtemp(join(tmpdir(), 'wrangler-gate-missing-'));
    try {
      await expect(checkWranglerExposure(join(missingDirectory, 'missing.jsonc'))).resolves.toEqual(
        [WRANGLER_RULES.read],
      );
    } finally {
      await rm(missingDirectory, { recursive: true, force: true });
    }
    await withConfig('', async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([WRANGLER_RULES.parse]);
    });
    await withConfig('{"workers_dev": false,', async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([WRANGLER_RULES.parse]);
    });
    await withConfig('{"workers_dev": false, "workers_dev": true}', async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([
        WRANGLER_RULES.duplicateKey,
      ]);
    });
    await withConfig('{"nested": {"route": [], "route": null}}', async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([
        WRANGLER_RULES.duplicateKey,
      ]);
    });
    await withConfig('[]', async (configPath) => {
      await expect(checkWranglerExposure(configPath)).resolves.toEqual([WRANGLER_RULES.rootObject]);
    });
  });

  it('prints only a safe file label and rule ID on failure and stays silent on success', async () => {
    const unsafeValue = 'fixture-value-never-echo';
    const config = validConfig();
    config.vars.TURNSTILE_SECRET = unsafeValue;
    await withConfig(JSON.stringify(config), async (configPath) => {
      let output = '';
      const status = await runWranglerExposureCheck(configPath, {
        write(chunk) {
          output += chunk;
          return true;
        },
      });
      expect(status).toBe(1);
      expect(output).toContain(`wrangler.jsonc [${WRANGLER_RULES.secretValue}]`);
      expect(output).not.toContain(unsafeValue);
      expect(output).not.toContain(tmpdir());
    });

    let cleanOutput = '';
    const status = await runWranglerExposureCheck(resolve('wrangler.jsonc'), {
      write(chunk) {
        cleanOutput += chunk;
        return true;
      },
    });
    expect(status).toBe(0);
    expect(cleanOutput).toBe('');
  });
});
