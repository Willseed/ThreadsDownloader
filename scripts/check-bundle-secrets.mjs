import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultBundleRoot = resolve(repositoryRoot, 'dist/web/browser');
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const forbiddenArchiveExtensions = new Set([
  '.7z',
  '.br',
  '.bz2',
  '.gz',
  '.jar',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zip',
  '.zst',
]);

const forbiddenRules = Object.freeze([
  ['BUNDLE_WORKER_SECRET_DOWNLOAD_ENCRYPTION', /DOWNLOAD_ENCRYPTION_KEY/iu],
  ['BUNDLE_WORKER_SECRET_RESOLVED_MEDIA_GRANT', /RESOLVED_MEDIA_GRANT_KEY/iu],
  ['BUNDLE_WORKER_SECRET_SESSION_SIGNING', /SESSION_SIGNING_KEY/iu],
  ['BUNDLE_WORKER_SECRET_TURNSTILE', /TURNSTILE_SECRET/iu],
  [
    'BUNDLE_RAW_CDN_URL',
    /https?:(?:\\*\/){2}[^\s"'<>]{0,512}cdninstagram(?:[.]|\\+[.]|\\+u002e|%2e)com/iu,
  ],
  ['BUNDLE_CDN_HOSTNAME', /cdninstagram(?:[.]|\\+[.]|\\+u002e|%2e)com/iu],
  ['BUNDLE_PRIVATE_TOKEN_MARKER', /private[-_][a-z0-9_-]*(?:token|secret)/iu],
  ['BUNDLE_PRIVATE_TOKEN_MARKER', /(?:token|secret)(?:=|[-_])private/iu],
  ['BUNDLE_PRIVATE_TOKEN_MARKER', /must[-_]never[-_](?:appear|expose|plaintext|persist)/iu],
]);

const unsafeLabelRules = forbiddenRules.map(
  ([, pattern]) => new RegExp(pattern.source, `${pattern.flags}g`),
);

function issue(ruleId, label = '<bundle-root>') {
  return { label, ruleId };
}

function sanitizeLabel(bundleRoot, entryPath) {
  const bundleRelative = relative(bundleRoot, entryPath);
  const withinBundle =
    bundleRelative !== '' &&
    bundleRelative !== '..' &&
    !bundleRelative.startsWith(`..${sep}`) &&
    !bundleRelative.includes('\0');
  if (!withinBundle) {
    return '<bundle-entry>';
  }

  let label = bundleRelative
    .split(sep)
    .join('/')
    .replaceAll(/[^a-zA-Z0-9._/-]/gu, '_');
  for (const pattern of unsafeLabelRules) {
    label = label.replaceAll(pattern, '[redacted]');
  }
  return label.length <= 160 ? label : `<bundle-entry>${extname(label).slice(0, 16)}`;
}

async function readRegularFile(entryPath) {
  const handle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      return { kind: 'unsupported' };
    }
    return { bytes: await handle.readFile(), kind: 'file' };
  } finally {
    await handle.close();
  }
}

function inspectBytes(bytes, label) {
  const issues = [];
  const byteText = bytes.toString('latin1');
  for (const [ruleId, pattern] of forbiddenRules) {
    if (pattern.test(byteText)) {
      issues.push(issue(ruleId, label));
    }
  }
  return issues;
}

function isNonemptyUtf8(bytes) {
  if (bytes.byteLength === 0) {
    return false;
  }
  try {
    utf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function startsWithBytes(bytes, prefix) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function hasArchiveMagic(bytes) {
  const prefixes = [
    [0x1f, 0x8b],
    [0x42, 0x5a, 0x68],
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
    [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    [0x28, 0xb5, 0x2f, 0xfd],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  ];
  if (prefixes.some((prefix) => startsWithBytes(bytes, prefix))) {
    return true;
  }
  return bytes.byteLength >= 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar';
}

function isArchiveArtifact(entryPath, bytes) {
  return forbiddenArchiveExtensions.has(extname(entryPath).toLowerCase()) || hasArchiveMagic(bytes);
}

async function walkDirectory(bundleRoot, directoryPath, state) {
  let entries;
  try {
    entries = await readdir(directoryPath);
  } catch {
    state.issues.push(
      issue('BUNDLE_DIRECTORY_READ_FAILED', sanitizeLabel(bundleRoot, directoryPath)),
    );
    return;
  }

  entries.sort((left, right) => left.localeCompare(right, 'en'));
  for (const entry of entries) {
    const entryPath = resolve(directoryPath, entry);
    const label = sanitizeLabel(bundleRoot, entryPath);
    await inspectEntry(bundleRoot, entryPath, label, state);
  }
}

async function inspectEntry(bundleRoot, entryPath, label, state) {
  let entryStat;
  try {
    entryStat = await lstat(entryPath);
  } catch {
    state.issues.push(issue('BUNDLE_ENTRY_STAT_FAILED', label));
    return;
  }
  if (entryStat.isSymbolicLink()) {
    state.issues.push(issue('BUNDLE_SYMLINK_FORBIDDEN', label));
    return;
  }
  if (entryStat.isDirectory()) {
    await walkDirectory(bundleRoot, entryPath, state);
    return;
  }
  if (!entryStat.isFile()) {
    state.issues.push(issue('BUNDLE_ENTRY_TYPE_FORBIDDEN', label));
    return;
  }

  let result;
  try {
    result = await readRegularFile(entryPath);
  } catch {
    state.issues.push(issue('BUNDLE_FILE_READ_FAILED', label));
    return;
  }
  if (result.kind !== 'file') {
    state.issues.push(issue('BUNDLE_ENTRY_TYPE_FORBIDDEN', label));
    return;
  }

  if (isArchiveArtifact(entryPath, result.bytes)) {
    state.issues.push(issue('BUNDLE_ARCHIVE_FORBIDDEN', label));
    return;
  }

  if (isNonemptyUtf8(result.bytes)) {
    state.nonemptyTextFiles += 1;
  }
  state.issues.push(...inspectBytes(result.bytes, label));
}

export async function scanBundle(bundleDirectory = defaultBundleRoot) {
  const requestedRoot = resolve(bundleDirectory);
  let rootStat;
  try {
    rootStat = await lstat(requestedRoot);
  } catch {
    return [issue('BUNDLE_ROOT_MISSING')];
  }
  if (rootStat.isSymbolicLink()) {
    return [issue('BUNDLE_ROOT_SYMLINK_FORBIDDEN')];
  }
  if (!rootStat.isDirectory()) {
    return [issue('BUNDLE_ROOT_NOT_DIRECTORY')];
  }

  let bundleRoot;
  try {
    bundleRoot = await realpath(requestedRoot);
  } catch {
    return [issue('BUNDLE_ROOT_REALPATH_FAILED')];
  }

  const state = { issues: [], nonemptyTextFiles: 0 };
  await walkDirectory(bundleRoot, bundleRoot, state);
  if (state.nonemptyTextFiles === 0) {
    state.issues.push(issue('BUNDLE_NO_NONEMPTY_TEXT'));
  }
  return state.issues;
}

export function formatBundleIssue({ ruleId }) {
  return `${ruleId} <bundle-entry>`;
}

async function main() {
  if (process.argv.length > 3) {
    process.stderr.write('BUNDLE_ARGUMENT_INVALID <bundle-root>\n');
    process.exitCode = 1;
    return;
  }

  const issues = await scanBundle(process.argv[2] ?? defaultBundleRoot);
  if (issues.length === 0) {
    return;
  }
  for (const currentIssue of issues) {
    process.stderr.write(`${formatBundleIssue(currentIssue)}\n`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write('BUNDLE_CHECK_FAILED <bundle-root>\n');
    process.exitCode = 1;
  });
}
