import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDeployReadiness, DEPLOY_READINESS_RULES } from './check-deploy-readiness.mjs';

const scriptPath = fileURLToPath(new URL('./check-deploy-readiness.mjs', import.meta.url));
const fixtureRoots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threads-downloader-deploy-'));
  fixtureRoots.push(root);
  return root;
}

async function writeFixture(root, path, contents) {
  const destination = join(root, path);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('deployment readiness gate', () => {
  it('accepts an explicit production approval without a pending legal marker', async () => {
    const root = await fixture();
    await writeFixture(
      root,
      'index.html',
      '<main data-legal-status="approved-for-production"></main>',
    );
    await writeFixture(root, 'nested/main.js', 'const pendingRequest = true;');

    await expect(checkDeployReadiness(root)).resolves.toEqual([]);
  });

  it.each([
    '<main data-legal-status="pending-operator-identity-and-legal-review"></main>',
    'const attrs=["data-legal-status","pending-legal-review"]',
    'const attrs={"data-legal-status":"pending-review"}',
  ])('rejects a pending legal status in compiled representation %#', async (contents) => {
    const root = await fixture();
    await writeFixture(root, 'nested/main.js', contents);

    await expect(checkDeployReadiness(root)).resolves.toEqual([
      DEPLOY_READINESS_RULES.approvalMissing,
      DEPLOY_READINESS_RULES.legalPending,
    ]);
  });

  it.each([
    '<main data-legal-status="approved-for-production"></main>',
    'const attrs=["data-legal-status","approved-for-production"]',
    'const attrs={"data-legal-status":"approved-for-production"}',
  ])('accepts an approved legal status in compiled representation %#', async (contents) => {
    const root = await fixture();
    await writeFixture(root, 'nested/main.js', contents);

    await expect(checkDeployReadiness(root)).resolves.toEqual([]);
  });

  it('rejects an absent or ambiguous approval marker', async () => {
    const root = await fixture();
    await writeFixture(root, 'index.html', '<main data-legal-status="review-complete"></main>');

    await expect(checkDeployReadiness(root)).resolves.toEqual([
      DEPLOY_READINESS_RULES.approvalMissing,
    ]);
  });

  it('fails closed for missing, empty, non-directory, and symlink bundle roots', async () => {
    const parent = await fixture();
    const missing = join(parent, 'missing');
    const missingParent = join(parent, 'missing-parent', 'missing');
    const empty = join(parent, 'empty');
    const file = await writeFixture(parent, 'file', 'safe');
    const linked = join(parent, 'linked');
    await mkdir(empty);
    await symlink(empty, linked);

    await expect(checkDeployReadiness(missing, parent)).resolves.toEqual([
      DEPLOY_READINESS_RULES.bundleMissing,
    ]);
    await expect(checkDeployReadiness(missingParent, parent)).resolves.toEqual([
      DEPLOY_READINESS_RULES.bundleMissing,
    ]);
    await expect(checkDeployReadiness(empty, parent)).resolves.toEqual([
      DEPLOY_READINESS_RULES.bundleEmpty,
    ]);
    await expect(checkDeployReadiness(file, parent)).resolves.toEqual([
      DEPLOY_READINESS_RULES.bundleNotDirectory,
    ]);
    await expect(checkDeployReadiness(linked, parent)).resolves.toEqual([
      DEPLOY_READINESS_RULES.entrySymlink,
    ]);
  });

  it('rejects a root whose intermediate symlink escapes the allowed root', async () => {
    const allowedRoot = await fixture();
    const outsideRoot = await fixture();
    await writeFixture(
      outsideRoot,
      'bundle/index.html',
      '<main data-legal-status="approved-for-production"></main>',
    );
    await symlink(outsideRoot, join(allowedRoot, 'escape'));

    await expect(
      checkDeployReadiness(join(allowedRoot, 'escape', 'bundle'), allowedRoot),
    ).resolves.toEqual([DEPLOY_READINESS_RULES.bundleOutsideRoot]);
  });

  it('fails closed when a nested entry is a symlink', async () => {
    const root = await fixture();
    await writeFixture(
      root,
      'index.html',
      '<main data-legal-status="approved-for-production"></main>',
    );
    const target = await writeFixture(root, 'target.js', 'safe');
    await symlink(target, join(root, 'linked.js'));

    await expect(checkDeployReadiness(root)).resolves.toEqual([
      DEPLOY_READINESS_RULES.entrySymlink,
    ]);
  });

  it('prints only fixed diagnostics when the command fails', async () => {
    const root = await fixture();
    await writeFixture(
      root,
      'main.js',
      'const attrs=["data-legal-status","approved-for-production"];' +
        'const unsafe=["data-legal-status","pending-operator-secret-review"]',
    );

    const result = spawnSync(process.execPath, [scriptPath, '.'], {
      cwd: root,
      encoding: 'utf8',
      env: {},
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('DEPLOY_LEGAL_STATUS_PENDING <web-bundle>\n');
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain('operator-secret');
  });

  it('rejects CLI traversal and absolute paths outside the invocation root', async () => {
    const invocationRoot = await fixture();
    const outsideRoot = await fixture();
    await writeFixture(
      outsideRoot,
      'index.html',
      '<main data-legal-status="approved-for-production"></main>',
    );

    for (const candidate of [relative(invocationRoot, outsideRoot), outsideRoot]) {
      const result = spawnSync(process.execPath, [scriptPath, candidate], {
        cwd: invocationRoot,
        encoding: 'utf8',
        env: {},
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('DEPLOY_BUNDLE_OUTSIDE_ALLOWED_ROOT <web-bundle>\n');
      expect(result.stderr).not.toContain(invocationRoot);
      expect(result.stderr).not.toContain(outsideRoot);
    }
  });
});
