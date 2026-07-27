import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

const workflowsRoot = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const workflowPath = fileURLToPath(new URL('../.github/workflows/main.yml', import.meta.url));
const sonarPropertiesPath = fileURLToPath(new URL('../sonar-project.properties', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const prettierIgnorePath = fileURLToPath(new URL('../.prettierignore', import.meta.url));

const expectedSonarProperties = [
  ['sonar.projectKey', 'Willseed_ThreadsDownloader'],
  ['sonar.organization', 'uukbr6yqj4o8tuefbjxkmceuwcvkyrdk'],
  ['sonar.projectName', 'Threads Downloader'],
  ['sonar.sourceEncoding', 'UTF-8'],
  ['sonar.sources', 'apps/web/src,apps/worker/src,packages/contracts/src,scripts'],
  [
    'sonar.tests',
    'apps/web/src,apps/worker/test,apps/worker/test-do,packages/contracts/test,e2e,scripts',
  ],
  ['sonar.exclusions', 'apps/web/src/**/*.spec.ts,scripts/**/*.spec.mjs'],
  ['sonar.cpd.exclusions', 'apps/web/src/app/core/i18n/locales/*.ts'],
  [
    'sonar.test.inclusions',
    'apps/web/src/**/*.spec.ts,apps/worker/test/**/*.spec.ts,apps/worker/test-do/**/*.spec.ts,packages/contracts/test/**/*.spec.ts,e2e/**/*.spec.ts,scripts/**/*.spec.mjs',
  ],
  [
    'sonar.javascript.lcov.reportPaths',
    'coverage/web/lcov.info,coverage/worker/lcov.info,coverage/contracts/lcov.info,coverage/scripts/lcov.info',
  ],
];

const actionPins = new Map([
  ['actions/checkout', { revision: '3d3c42e5aac5ba805825da76410c181273ba90b1', version: 'v7.0.1' }],
  [
    'actions/setup-node',
    { revision: '820762786026740c76f36085b0efc47a31fe5020', version: 'v7.0.0' },
  ],
  [
    'actions/upload-artifact',
    { revision: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', version: 'v7.0.1' },
  ],
  [
    'actions/download-artifact',
    { revision: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', version: 'v8.0.1' },
  ],
  [
    'SonarSource/sonarqube-scan-action',
    { revision: '22918119ff8e1ca75a623e15c8296b6ea4fbe28f', version: 'v8.2.1' },
  ],
  [
    'gitleaks/gitleaks-action',
    { revision: 'e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e', version: 'v3.0.0' },
  ],
]);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

function parseProperties(contents) {
  const properties = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error('invalid property');
    }
    const key = line.slice(0, separator);
    if (properties.has(key)) {
      throw new Error('duplicate property');
    }
    properties.set(key, line.slice(separator + 1));
  }
  return properties;
}

describe('main workflow policy', () => {
  it('keeps main.yml as the only parseable workflow', async () => {
    await expect(readdir(workflowsRoot)).resolves.toEqual(['main.yml']);
    const source = await workflow();

    await expect(format(source, { parser: 'yaml' })).resolves.toContain('name: Main');
  });

  it('pins every external action to its verified release commit', async () => {
    const source = await workflow();
    const references = source
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith('uses:'))
      .map((line) =>
        line
          .trim()
          .match(/^uses: ([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)@([\da-f]{40}) # (v\d+(?:\.\d+){0,2})$/u),
      );

    expect(references).toHaveLength(16);
    expect(references).not.toContain(null);
    for (const reference of references) {
      if (reference === null) {
        continue;
      }
      const [, action, revision, version] = reference;
      expect(actionPins.get(action)).toEqual({ revision, version });
    }
    expect(references.filter((reference) => reference?.[1] === 'actions/checkout')).toHaveLength(3);
    expect(references.filter((reference) => reference?.[1] === 'actions/setup-node')).toHaveLength(
      3,
    );
    expect(
      references.filter((reference) => reference?.[1] === 'actions/upload-artifact'),
    ).toHaveLength(4);
    expect(
      references.filter((reference) => reference?.[1] === 'actions/download-artifact'),
    ).toHaveLength(4);
  });

  it('removes only the Gitleaks scratch report immediately after scanning', async () => {
    const [source, packageDocument, prettierIgnore] = await Promise.all([
      workflow(),
      readFile(packagePath, 'utf8').then((contents) => JSON.parse(contents)),
      readFile(prettierIgnorePath, 'utf8'),
    ]);
    const scanAndCleanup = [
      '      - name: Scan repository history for secrets',
      '        uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0',
      '        env:',
      '          GITHUB_TOKEN: ${{ github.token }}',
      "          GITLEAKS_ENABLE_COMMENTS: 'false'",
      "          GITLEAKS_ENABLE_SUMMARY: 'false'",
      "          GITLEAKS_ENABLE_UPLOAD_ARTIFACT: 'false'",
      '      - name: Remove Gitleaks runner report',
      '        if: always()',
      '        run: rm -f -- results.sarif',
      '      - name: Install locked dependencies',
    ].join('\n');

    expect(source).toContain(scanAndCleanup);
    expect([...source.matchAll(/\brm(?:\s|$)[^\n]*/gu)].map((match) => match[0])).toEqual([
      'rm -f -- results.sarif',
    ]);
    expect(source.match(/results\.sarif/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\.prettierignore|--ignore-(?:path|pattern)|prettier-ignore/iu);
    expect(packageDocument['scripts']?.['format:check']).toBe('prettier --check .');
    expect(prettierIgnore).not.toMatch(/sarif|results\.|\*\.json/iu);
  });

  it('runs only main through verify, sonar, and deploy in strict dependency order', async () => {
    const source = await workflow();
    const jobs = source.slice(source.indexOf('\njobs:\n'));
    const jobNames = [...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gmu)].map((match) => match[1]);

    expect(jobNames).toEqual(['verify', 'sonar', 'deploy']);
    expect(source).toContain("if: github.ref == 'refs/heads/main'");
    expect(source).toMatch(/push:\n\s+branches:\n\s+- main/u);
    expect(source).toMatch(/workflow_dispatch:\s*$/mu);
    expect(source).toMatch(/sonar:\n[\s\S]*?needs: verify/u);
    expect(source).toMatch(/deploy:\n[\s\S]*?needs: \[verify, sonar\]/u);
    expect(source.match(/ref: \$\{\{ github\.sha \}\}/gu)).toHaveLength(3);
    expect(source.match(/fetch-depth: 0/gu)).toHaveLength(3);
    expect(source.match(/persist-credentials: false/gu)).toHaveLength(3);
    expect(source.match(/node-version: 24\.18\.0/gu)).toHaveLength(3);
    expect(source.match(/run: test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu)).toHaveLength(3);
  });

  it('runs every required verification gate without bypass syntax', async () => {
    const source = await workflow();
    for (const command of [
      'npm ci',
      'npm audit --audit-level=low',
      'npm run format:check',
      'npm run lint',
      'npm run typecheck',
      'npm run coverage',
      'npm run test:do',
      'npm run test:range',
      'npm run test:security',
      'npm run test:e2e',
      'npm run test:accessibility',
      'npm run build:web',
      'npm run security:bundle',
      'npm run security:wrangler',
      'npm run worker:dry-run',
    ]) {
      expect(source).toContain(command);
    }
    expect(source).not.toMatch(/continue-on-error|\|\|\s*true|\[skip ci\]|--no-verify/iu);
    expect(source).not.toContain('cloudflare/wrangler-action');
  });

  it('moves four same-revision LCOV artifacts into Sonar', async () => {
    const source = await workflow();
    for (const workspace of ['web', 'worker', 'contracts', 'scripts']) {
      expect(
        source.match(new RegExp(`name: lcov-${workspace}-\\$\\{\\{ github\\.sha \\}\\}`, 'gu')),
      ).toHaveLength(2);
      expect(source).toContain(`path: coverage/${workspace}/lcov.info`);
    }
    expect(source).toContain('SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}');
    expect(source).not.toContain('SONAR_HOST_URL');
    expect(source).not.toContain('continue-on-error');
  });

  it('allows exactly two approved scanner arguments and only the Sonar token', async () => {
    const source = await workflow();
    const scannerStep = [
      '      - name: Scan with SonarQube Cloud and wait for Quality Gate',
      '        uses: SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f # v8.2.1',
      '        env:',
      '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
      '        with:',
      '          args: >',
      '            -Dsonar.qualitygate.wait=true',
      '            -Dsonar.qualitygate.timeout=600',
    ].join('\n');

    expect(source).toContain(
      `${scannerStep}\n      - name: Verify exact Sonar analysis and zero open findings`,
    );
    expect(source.match(/SonarSource\/sonarqube-scan-action@/gu)).toHaveLength(1);
  });

  it('covers only the four production security scripts in the root LCOV report', async () => {
    const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
    const scripts = packageDocument['scripts'];
    expect(scripts?.['coverage']).toContain('npm run coverage:scripts');
    expect(scripts?.['test:security']).toBe('vitest run scripts/*.spec.mjs');
    const expectedSources = [
      'scripts/check-bundle-secrets.mjs',
      'scripts/check-deploy-readiness.mjs',
      'scripts/check-sonar-open-issues.mjs',
      'scripts/check-wrangler-exposure.mjs',
    ];
    const includedSources = [
      ...(scripts?.['coverage:scripts']?.matchAll(/--coverage\.include=([^\s]+)/gu) ?? []),
    ].map((match) => match[1]);
    expect(includedSources).toEqual(expectedSources);
  });

  it('limits secrets and deployment commands to the approved boundaries', async () => {
    const source = await workflow();
    const secretNames = [...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]);

    expect(secretNames.sort()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'SONAR_TOKEN',
    ]);
    expect(source).toContain('permissions:\n  contents: read');
    const remoteMainStep = [
      '      - name: Require current remote main revision',
      '        shell: bash',
      '        run: |',
      '          remote_main_ref="$(git ls-remote --exit-code origin refs/heads/main 2>/dev/null)" || {',
      "            printf '%s\\n' 'DEPLOY_REMOTE_MAIN_LOOKUP_FAILED' >&2",
      '            exit 1',
      '          }',
      '          expected_main_ref="${GITHUB_SHA}"$\'\\trefs/heads/main\'',
      '          if [[ "$remote_main_ref" != "$expected_main_ref" ]]; then',
      "            printf '%s\\n' 'DEPLOY_REMOTE_MAIN_REVISION_MISMATCH' >&2",
      '            exit 1',
      '          fi',
    ].join('\n');
    const deployStep = [
      '      - name: Deploy locked Wrangler build',
      '        run: npm exec -- wrangler deploy --config wrangler.jsonc',
    ].join('\n');
    expect(source).toContain(`${remoteMainStep}\n${deployStep}`);
    expect(source.indexOf('npm run security:deploy-ready')).toBeLessThan(
      source.indexOf(remoteMainStep),
    );
    expect(source).not.toMatch(
      /wrangler\s+(?:route|routes|domain|domains|dns)|custom[-_ ]domain|tls/iu,
    );
    expect(source).toContain('https://threads.pylot.dev/');
    expect(source).toContain('https://threads.pylot.dev/api/health');
  });
});

describe('Sonar project policy', () => {
  it('allows only the exact approved source, test, CPD exclusion, and four-LCOV properties', async () => {
    const properties = parseProperties(await readFile(sonarPropertiesPath, 'utf8'));

    expect([...properties]).toEqual(expectedSonarProperties);
  });
});
