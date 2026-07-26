import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { scanBundle } from './check-bundle-secrets.mjs';

const scriptPath = fileURLToPath(new URL('./check-bundle-secrets.mjs', import.meta.url));
const fixtureRoots = [];
const privateTokenMarker = ['fixture', 'private', 'token', 'marker'].join('-');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threads-downloader-bundle-'));
  fixtureRoots.push(root);
  return root;
}

async function writeFixture(root, path, contents) {
  const destination = join(root, path);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}

function ruleIds(issues) {
  return issues.map(({ ruleId }) => ruleId);
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('bundle secret gate', () => {
  it('recursively accepts public browser configuration across text artifact types', async () => {
    const root = await fixture();
    const publicConfiguration = 'TURNSTILE_SITE_KEY https://threads.pylot.dev';
    for (const [index, extension] of ['js', 'html', 'css', 'json', 'map'].entries()) {
      await writeFixture(root, `nested/${String(index)}/asset.${extension}`, publicConfiguration);
    }

    expect(await scanBundle(root)).toEqual([]);
  });

  it.each([
    ['DOWNLOAD_ENCRYPTION_KEY', 'BUNDLE_WORKER_SECRET_DOWNLOAD_ENCRYPTION'],
    ['RESOLVED_MEDIA_GRANT_KEY', 'BUNDLE_WORKER_SECRET_RESOLVED_MEDIA_GRANT'],
    ['SESSION_SIGNING_KEY', 'BUNDLE_WORKER_SECRET_SESSION_SIGNING'],
    ['TURNSTILE_SECRET', 'BUNDLE_WORKER_SECRET_TURNSTILE'],
    [privateTokenMarker, 'BUNDLE_PRIVATE_TOKEN_MARKER'],
  ])('rejects forbidden marker rule %s', async (marker, expectedRule) => {
    const root = await fixture();
    await writeFixture(root, 'nested/main.js', marker);

    expect(ruleIds(await scanBundle(root))).toContain(expectedRule);
  });

  it('rejects literal and escaped CDN hostnames and raw URLs assembled at runtime', async () => {
    const cdnHost = ['video', 'cdninstagram', 'com'].join('.');
    const escapedHost = cdnHost.replaceAll('.', String.raw`\.`);
    const rawUrl = ['https:/', '', cdnHost, 'media'].join('/');
    const escapedUrl = rawUrl.replaceAll('/', String.raw`\/`).replaceAll('.', String.raw`\.`);

    for (const contents of [cdnHost, escapedHost, rawUrl, escapedUrl]) {
      const root = await fixture();
      await writeFixture(root, 'main.js', contents);
      const foundRules = ruleIds(await scanBundle(root));
      expect(foundRules).toContain('BUNDLE_CDN_HOSTNAME');
      if (contents.includes(':')) {
        expect(foundRules).toContain('BUNDLE_RAW_CDN_URL');
      }
    }
  });

  it('scans forbidden ASCII bytes even when an artifact is not valid UTF-8', async () => {
    const root = await fixture();
    await writeFixture(root, 'index.html', '<main>safe</main>');
    await writeFixture(
      root,
      'nested/blob.bin',
      Buffer.concat([Buffer.from([0xff]), Buffer.from('SESSION_SIGNING_KEY')]),
    );

    expect(ruleIds(await scanBundle(root))).toContain('BUNDLE_WORKER_SECRET_SESSION_SIGNING');
  });

  it('fails closed on compressed extensions and archive magic bytes', async () => {
    const root = await fixture();
    await writeFixture(root, 'index.html', '<main>safe</main>');
    await writeFixture(root, 'assets/chunk.js.gz', 'obvious-fixture-content');
    await writeFixture(root, 'assets/renamed.bin', Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

    expect(ruleIds(await scanBundle(root))).toEqual([
      'BUNDLE_ARCHIVE_FORBIDDEN',
      'BUNDLE_ARCHIVE_FORBIDDEN',
    ]);
  });

  it('fails closed for missing, non-directory, empty, binary-only, and symlink roots', async () => {
    const parent = await fixture();
    const missing = join(parent, 'missing');
    const missingParent = join(parent, 'missing-parent', 'missing');
    const fileRoot = await writeFixture(parent, 'not-a-directory', 'safe');
    const emptyRoot = join(parent, 'empty');
    const binaryRoot = join(parent, 'binary');
    const symlinkRoot = join(parent, 'linked');
    await mkdir(emptyRoot);
    await mkdir(binaryRoot);
    await writeFixture(binaryRoot, 'asset.bin', Buffer.from([0xff, 0xfe]));
    await symlink(emptyRoot, symlinkRoot);

    expect(ruleIds(await scanBundle(missing, parent))).toEqual(['BUNDLE_ROOT_MISSING']);
    expect(ruleIds(await scanBundle(missingParent, parent))).toEqual(['BUNDLE_ROOT_MISSING']);
    expect(ruleIds(await scanBundle(fileRoot, parent))).toEqual(['BUNDLE_ROOT_NOT_DIRECTORY']);
    expect(ruleIds(await scanBundle(emptyRoot, parent))).toEqual(['BUNDLE_NO_NONEMPTY_TEXT']);
    expect(ruleIds(await scanBundle(binaryRoot, parent))).toEqual(['BUNDLE_NO_NONEMPTY_TEXT']);
    expect(ruleIds(await scanBundle(symlinkRoot, parent))).toEqual([
      'BUNDLE_ROOT_SYMLINK_FORBIDDEN',
    ]);
  });

  it('rejects a root whose intermediate symlink escapes the allowed root', async () => {
    const allowedRoot = await fixture();
    const outsideRoot = await fixture();
    await writeFixture(outsideRoot, 'bundle/index.html', '<main>safe</main>');
    await symlink(outsideRoot, join(allowedRoot, 'escape'));

    expect(ruleIds(await scanBundle(join(allowedRoot, 'escape', 'bundle'), allowedRoot))).toEqual([
      'BUNDLE_ROOT_OUTSIDE_ALLOWED_ROOT',
    ]);
  });

  it('fails closed for nested symlinks without following their target', async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFixture(root, 'index.html', '<main>safe</main>');
    const target = await writeFixture(outside, 'outside.js', 'safe');
    await symlink(target, join(root, 'nested.js'));

    expect(await scanBundle(root)).toContainEqual({
      label: 'nested.js',
      ruleId: 'BUNDLE_SYMLINK_FORBIDDEN',
    });
  });

  it('emits only a stable rule and fixed label on failure and stays silent on success', async () => {
    const failingRoot = await fixture();
    const safeRoot = await fixture();
    const unsafeFilename = 'unknown-sensitive-filename-fixture.js';
    await writeFixture(failingRoot, `nested/${unsafeFilename}`, privateTokenMarker);
    await writeFixture(safeRoot, 'main.js', 'TURNSTILE_SITE_KEY https://threads.pylot.dev');

    const failure = spawnSync(process.execPath, [scriptPath, '.'], {
      cwd: failingRoot,
      encoding: 'utf8',
    });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toBe('BUNDLE_PRIVATE_TOKEN_MARKER <bundle-entry>\n');
    expect(failure.stderr).not.toContain(privateTokenMarker);
    expect(failure.stderr).not.toContain(failingRoot);
    expect(failure.stderr).not.toContain(unsafeFilename);

    const success = spawnSync(process.execPath, [scriptPath, '.'], {
      cwd: safeRoot,
      encoding: 'utf8',
    });
    expect(success.status).toBe(0);
    expect(success.stdout).toBe('');
    expect(success.stderr).toBe('');
  });

  it('rejects CLI traversal and absolute paths outside the invocation root', async () => {
    const invocationRoot = await fixture();
    const outsideRoot = await fixture();
    await writeFixture(outsideRoot, 'index.html', '<main>safe</main>');

    for (const candidate of [relative(invocationRoot, outsideRoot), outsideRoot]) {
      const result = spawnSync(process.execPath, [scriptPath, candidate], {
        cwd: invocationRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('BUNDLE_ROOT_OUTSIDE_ALLOWED_ROOT <bundle-entry>\n');
      expect(result.stderr).not.toContain(invocationRoot);
      expect(result.stderr).not.toContain(outsideRoot);
    }
  });
});
