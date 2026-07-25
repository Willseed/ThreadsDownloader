import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DownloadSession } from '../src/download-session.js';
import { createOpaqueId } from '../src/security/cryptography.js';
import { decodeBase64Url, encodeBase64Url } from '../src/utils/base64url.js';

interface TestEnv {
  readonly DOWNLOAD_SESSIONS: DurableObjectNamespace<DownloadSession>;
}

type StorageValue = string | number | ArrayBuffer | null;

interface ChangeRow {
  readonly [key: string]: StorageValue;
  readonly changes: number;
}

interface TableRow {
  readonly [key: string]: StorageValue;
  readonly name: string;
}

interface StoredRow {
  readonly [key: string]: StorageValue;
}

interface StorageSnapshot {
  readonly changes: number;
  readonly alarmAt: number | null;
  readonly tables: readonly string[];
  readonly sessionRows: readonly StoredRow[];
  readonly intervalRows: readonly StoredRow[];
  readonly leaseRows: readonly StoredRow[];
}

interface DownloadFixture {
  readonly target: DurableObjectStub<DownloadSession>;
  readonly downloadId: string;
  readonly sessionHash: string;
  readonly body: {
    readonly downloadId: string;
    readonly sessionHash: string;
    readonly filename: string;
    readonly shortcode: string;
    readonly media: typeof media;
  };
}

const testEnv = env as unknown as TestEnv;
const privateUrl = 'https://video.cdninstagram.com/media/private.mp4?token=must-remain-encrypted';
const media = {
  finalUrl: privateUrl,
  contentType: 'video/mp4',
  contentLength: 42,
  rangeCapability: 'bytes',
  strongEtag: '"workerd-etag"',
  lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
  completionReliable: true,
  probeMethod: 'head',
} as const;

function fixture(): DownloadFixture {
  const downloadId = createOpaqueId(192);
  const sessionHash = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return {
    target: testEnv.DOWNLOAD_SESSIONS.get(testEnv.DOWNLOAD_SESSIONS.idFromName(downloadId)),
    downloadId,
    sessionHash,
    body: {
      downloadId,
      sessionHash,
      filename: 'threads_Abcde_1.mp4',
      shortcode: 'Abcde',
      media,
    },
  };
}

function statusRequest(
  current: DownloadFixture,
  id = current.downloadId,
  hash = current.sessionHash,
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ downloadId: id, sessionHash: hash }),
  };
}

function headRequest(
  current: DownloadFixture,
  id = current.downloadId,
  hash = current.sessionHash,
): RequestInit {
  return {
    method: 'HEAD',
    headers: { 'x-download-id': id, 'x-session-hash': hash },
  };
}

async function initialize(current: DownloadFixture): Promise<Response> {
  return current.target.fetch('https://download.internal/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(current.body),
  });
}

async function post(current: DownloadFixture, path: string, body: unknown): Promise<Response> {
  return current.target.fetch(`https://download.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function acquire(
  current: DownloadFixture,
  rangeHeader: string | null = null,
  ifRangeHeader: string | null = null,
): Promise<Response> {
  return post(current, '/acquire', {
    downloadId: current.downloadId,
    sessionHash: current.sessionHash,
    rangeHeader,
    ifRangeHeader,
  });
}

async function finishRange(
  current: DownloadFixture,
  holderId: string,
  start: number,
  end: number,
): Promise<Response> {
  return post(current, '/finish', {
    downloadId: current.downloadId,
    sessionHash: current.sessionHash,
    holderId,
    sequence: 0,
    normalEof: true,
    actualBytes: end - start + 1,
    upstream: {
      status: 206,
      headers: {
        contentLength: String(end - start + 1),
        contentRange: `bytes ${String(start)}-${String(end)}/${String(media.contentLength)}`,
        etag: media.strongEtag,
        lastModified: media.lastModified,
      },
    },
  });
}

async function snapshot(target: DurableObjectStub<DownloadSession>): Promise<StorageSnapshot> {
  return runInDurableObject(target, async (_instance, state) => {
    const changes = state.storage.sql
      .exec<ChangeRow>('SELECT total_changes() AS changes')
      .toArray()[0]!.changes;
    const tables = state.storage.sql
      .exec<TableRow>(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'download_%'
         ORDER BY name`,
      )
      .toArray()
      .map((row) => row.name);
    const sessionRows = tables.includes('download_session')
      ? state.storage.sql.exec<StoredRow>('SELECT * FROM download_session').toArray()
      : [];
    const intervalRows = tables.includes('download_completed_intervals')
      ? state.storage.sql.exec<StoredRow>('SELECT * FROM download_completed_intervals').toArray()
      : [];
    const leaseRows = tables.includes('download_active_leases')
      ? state.storage.sql.exec<StoredRow>('SELECT * FROM download_active_leases').toArray()
      : [];
    return {
      changes,
      alarmAt: await state.storage.getAlarm(),
      tables,
      sessionRows,
      intervalRows,
      leaseRows,
    };
  });
}

describe('DownloadSession read-only paths in workerd', () => {
  it('does not create storage or alarms for unknown HEAD/status requests', async () => {
    const current = fixture();
    const { target } = current;
    const before = await snapshot(target);
    expect(before).toEqual({
      changes: 0,
      alarmAt: null,
      tables: [],
      sessionRows: [],
      intervalRows: [],
      leaseRows: [],
    });

    const head = await target.fetch('https://download.internal/inspect', headRequest(current));
    expect(head.status).toBe(410);
    await expect(head.text()).resolves.toBe('');
    const status = await target.fetch('https://download.internal/status', statusRequest(current));
    expect(status.status).toBe(410);
    await expect(status.json()).resolves.toEqual({ ok: false });
    expect(await snapshot(target)).toEqual(before);
  });

  it('persists encrypted media once and keeps HEAD/status fully read-only', async () => {
    const current = fixture();
    const { target } = current;
    const initialized = await initialize(current);
    expect(initialized.status).toBe(201);
    const before = await snapshot(target);
    expect(before.tables).toEqual([
      'download_active_leases',
      'download_completed_intervals',
      'download_session',
    ]);
    expect(before.sessionRows).toHaveLength(1);
    expect(before.intervalRows).toEqual([]);
    expect(before.leaseRows).toEqual([]);
    expect(before.alarmAt).not.toBeNull();
    expect(JSON.stringify(before.sessionRows)).not.toContain(privateUrl);
    expect(JSON.stringify(before.sessionRows)).not.toContain('must-remain-encrypted');

    const head = await target.fetch('https://download.internal/inspect', headRequest(current));
    expect(head.status).toBe(200);
    expect(head.headers.get('x-download-filename')).toBe(current.body.filename);
    expect(head.headers.get('content-type')).toBe(current.body.media.contentType);
    expect(head.headers.get('content-length')).toBe(String(current.body.media.contentLength));
    expect(head.headers.get('etag')).toBe(current.body.media.strongEtag);
    expect(head.headers.get('last-modified')).toBe(current.body.media.lastModified);
    expect(head.headers.get('x-download-range-capability')).toBe(
      current.body.media.rangeCapability,
    );
    await expect(head.text()).resolves.toBe('');

    const status = await target.fetch('https://download.internal/status', statusRequest(current));
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      filename: current.body.filename,
      contentType: current.body.media.contentType,
      contentLength: current.body.media.contentLength,
      strongEtag: current.body.media.strongEtag,
      lastModified: current.body.media.lastModified,
      rangeCapability: current.body.media.rangeCapability,
      status: 'ISSUED',
      available: true,
      activeStreams: 0,
    });
    expect(await snapshot(target)).toEqual(before);
  });

  it('returns fixed binding and logical-expiry failures without mutations', async () => {
    const current = fixture();
    const { target } = current;
    expect((await initialize(current)).status).toBe(201);

    const otherDownloadId = createOpaqueId(192);
    const otherSessionHash = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

    expect(
      (
        await target.fetch(
          'https://download.internal/inspect',
          headRequest(current, otherDownloadId),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await target.fetch(
          'https://download.internal/status',
          statusRequest(current, current.downloadId, otherSessionHash),
        )
      ).status,
    ).toBe(401);

    await runInDurableObject(target, (_instance, state) => {
      const issuedAt = Date.now() - 120_001;
      state.storage.sql.exec(
        `UPDATE download_session
         SET issued_at = ?, start_expires_at = ?, absolute_expires_at = ?
         WHERE singleton = 1`,
        issuedAt,
        issuedAt + 120_000,
        issuedAt + 3_600_000,
      );
    });
    const expiredSnapshot = await snapshot(target);
    expect(
      (await target.fetch('https://download.internal/inspect', headRequest(current))).status,
    ).toBe(410);
    expect(
      (await target.fetch('https://download.internal/status', statusRequest(current))).status,
    ).toBe(410);
    expect(await snapshot(target)).toEqual(expiredSnapshot);
  });
});

describe('DownloadSession lifecycle in workerd', () => {
  it('returns canonical range failures and enforces the four-lease limit', async () => {
    const known = fixture();
    expect((await initialize(known)).status).toBe(201);
    for (const rangeHeader of ['malformed', 'bytes=0-1,2-3', 'bytes=42-']) {
      const rejected = await acquire(known, rangeHeader, media.strongEtag);
      expect(rejected.status).toBe(416);
      expect(rejected.headers.get('content-range')).toBe('bytes */42');
    }

    const nonRange = fixture();
    expect(
      (
        await post(nonRange, '/initialize', {
          ...nonRange.body,
          media: { ...nonRange.body.media, rangeCapability: 'none' },
        })
      ).status,
    ).toBe(201);
    const nonRangeBefore = await snapshot(nonRange.target);
    const unsupported = await acquire(nonRange, 'bytes=0-1', media.strongEtag);
    expect(unsupported.status).toBe(416);
    expect(unsupported.headers.get('content-range')).toBe('bytes */42');
    expect(await snapshot(nonRange.target)).toEqual(nonRangeBefore);
    const nonRangeFull = await acquire(nonRange, 'bytes=0-1', '"other"');
    expect(nonRangeFull.status).toBe(201);
    await expect(nonRangeFull.json()).resolves.toMatchObject({
      request: { requestedInterval: null },
    });

    const ifRangeMismatch = await acquire(known, 'bytes=0-1', '"other"');
    expect(ifRangeMismatch.status).toBe(201);
    await expect(ifRangeMismatch.json()).resolves.toMatchObject({
      request: { requestedInterval: null },
    });

    const unknown = fixture();
    const unknownInitialization = await post(unknown, '/initialize', {
      ...unknown.body,
      media: { ...unknown.body.media, contentLength: null, completionReliable: false },
    });
    expect(unknownInitialization.status).toBe(201);
    const unavailable = await acquire(unknown, 'bytes=0-1', media.strongEtag);
    expect(unavailable.status).toBe(416);
    expect(unavailable.headers.get('content-range')).toBeNull();

    const parallel = fixture();
    expect((await initialize(parallel)).status).toBe(201);
    const holders = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const response = await acquire(parallel);
      expect(response.status).toBe(201);
      holders.add(((await response.json()) as { readonly holderId: string }).holderId);
    }
    expect(holders).toHaveLength(4);
    expect((await acquire(parallel)).status).toBe(429);
    expect((await snapshot(parallel.target)).leaseRows).toHaveLength(4);
    const releasedHolder = [...holders][0]!;
    expect(
      (
        await post(parallel, '/interrupt', {
          downloadId: parallel.downloadId,
          sessionHash: parallel.sessionHash,
          holderId: releasedHolder,
          sequence: 0,
        })
      ).status,
    ).toBe(200);
    const replacement = (await (await acquire(parallel)).json()) as { readonly holderId: string };
    expect(decodeBase64Url(replacement.holderId)).toHaveLength(24);
    expect(holders.has(replacement.holderId)).toBe(false);
    const replacementSnapshot = await snapshot(parallel.target);
    expect(replacementSnapshot.leaseRows).toHaveLength(4);
    expect(replacementSnapshot.leaseRows.map((row) => row['holder_id'])).not.toContain(
      releasedHolder,
    );
  });

  it('decrypts only into the acquire response and restores partial ranges on a new stub', async () => {
    const current = fixture();
    expect((await initialize(current)).status).toBe(201);

    const firstAcquire = await acquire(current, 'bytes=0-20', media.strongEtag);
    expect(firstAcquire.status).toBe(201);
    const firstBody = (await firstAcquire.json()) as {
      readonly holderId: string;
      readonly media: { readonly finalUrl: string };
    };
    expect(firstBody.media.finalUrl).toBe(privateUrl);
    expect((await finishRange(current, firstBody.holderId, 0, 20)).status).toBe(200);
    const partial = await snapshot(current.target);
    expect(partial.intervalRows).toEqual([{ start_byte: 0, end_byte: 20, total_bytes: 42 }]);
    expect(partial.leaseRows).toEqual([]);
    expect(JSON.stringify(partial.sessionRows)).not.toContain(privateUrl);

    const restarted: DownloadFixture = {
      ...current,
      target: testEnv.DOWNLOAD_SESSIONS.get(
        testEnv.DOWNLOAD_SESSIONS.idFromName(current.downloadId),
      ),
    };
    const secondAcquire = await acquire(restarted, 'bytes=21-41', media.strongEtag);
    const secondHolder = ((await secondAcquire.json()) as { readonly holderId: string }).holderId;
    expect((await finishRange(restarted, secondHolder, 21, 41)).status).toBe(200);
    const completed = await snapshot(restarted.target);
    expect(completed.intervalRows).toEqual([{ start_byte: 0, end_byte: 41, total_bytes: 42 }]);
    expect(completed.leaseRows).toEqual([]);
    expect(completed.sessionRows[0]?.['status']).toBe('COMPLETE_PENDING');

    await runInDurableObject(restarted.target, (_instance, state) => {
      const now = Date.now();
      const issuedAt = now - 200_000;
      const lastActivityAt = now - 90_001;
      state.storage.sql.exec(
        `UPDATE download_session SET
           issued_at = ?, start_expires_at = ?, last_activity_at = ?, idle_expires_at = ?,
           absolute_expires_at = ?, completion_expires_at = ?
         WHERE singleton = 1`,
        issuedAt,
        issuedAt + 120_000,
        lastActivityAt,
        lastActivityAt + 600_000,
        issuedAt + 3_600_000,
        lastActivityAt + 90_000,
      );
    });
    expect(await runDurableObjectAlarm(restarted.target)).toBe(true);
    expect((await snapshot(restarted.target)).tables).toEqual([]);
  });

  it('renews monotonically, replaces an ended holder, and destroys without tombstones', async () => {
    const current = fixture();
    expect((await initialize(current)).status).toBe(201);
    const acquired = (await (await acquire(current)).json()) as { readonly holderId: string };
    const renewed = await post(current, '/renew', {
      downloadId: current.downloadId,
      sessionHash: current.sessionHash,
      holderId: acquired.holderId,
      sequence: 1,
    });
    expect(renewed.status).toBe(200);
    expect(
      (
        await post(current, '/renew', {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
          holderId: acquired.holderId,
          sequence: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(current, '/interrupt', {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
          holderId: acquired.holderId,
          sequence: 1,
        })
      ).status,
    ).toBe(200);
    const replacement = (await (await acquire(current)).json()) as { readonly holderId: string };
    expect(replacement.holderId).not.toBe(acquired.holderId);

    const replacementSnapshot = await snapshot(current.target);
    const oldHolderRequests = [
      [
        '/renew',
        {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
          holderId: acquired.holderId,
          sequence: 2,
        },
      ],
      [
        '/interrupt',
        {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
          holderId: acquired.holderId,
          sequence: 1,
        },
      ],
      [
        '/finish',
        {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
          holderId: acquired.holderId,
          sequence: 1,
          normalEof: true,
          actualBytes: 42,
          upstream: {
            status: 200,
            headers: {
              contentLength: '42',
              contentRange: null,
              etag: media.strongEtag,
              lastModified: media.lastModified,
            },
          },
        },
      ],
    ] as const;
    for (const [path, body] of oldHolderRequests) {
      expect((await post(current, path, body)).status).toBe(409);
      expect(await snapshot(current.target)).toEqual(replacementSnapshot);
    }

    const wrongHash = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const beforeWrongDestroy = await snapshot(current.target);
    expect(
      (
        await post(current, '/destroy', {
          downloadId: current.downloadId,
          sessionHash: wrongHash,
        })
      ).status,
    ).toBe(401);
    expect(await snapshot(current.target)).toEqual(beforeWrongDestroy);

    expect(
      (
        await post(current, '/destroy', {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
        })
      ).status,
    ).toBe(200);
    expect((await snapshot(current.target)).tables).toEqual([]);
    expect(
      (
        await post(current, '/destroy', {
          downloadId: current.downloadId,
          sessionHash: current.sessionHash,
        })
      ).status,
    ).toBe(410);
  });

  it('prunes expired leases on alarm, retains one lease, and deletes at idle expiry', async () => {
    const current = fixture();
    expect((await initialize(current)).status).toBe(201);
    const expiredHolder = createOpaqueId(192);
    const retainedHolder = createOpaqueId(192);
    await runInDurableObject(current.target, (_instance, state) => {
      const now = Date.now();
      const issuedAt = now - 1_000_000;
      const lastActivityAt = now - 1_000;
      state.storage.sql.exec(
        `UPDATE download_session SET
           status = 'ACTIVE', issued_at = ?, start_expires_at = ?, last_activity_at = ?,
           idle_expires_at = ?, absolute_expires_at = ?, completion_expires_at = NULL
         WHERE singleton = 1`,
        issuedAt,
        issuedAt + 120_000,
        lastActivityAt,
        lastActivityAt + 600_000,
        issuedAt + 3_600_000,
      );
      state.storage.sql.exec('DELETE FROM download_active_leases');
      state.storage.sql.exec(
        `INSERT INTO download_active_leases
           (holder_id, sequence, acquired_at, renewed_at, expires_at,
            requested_start, requested_end, requested_total)
         VALUES (?, 0, ?, ?, ?, NULL, NULL, NULL)`,
        expiredHolder,
        issuedAt + 1,
        issuedAt + 1,
        issuedAt + 900_001,
      );
      state.storage.sql.exec(
        `INSERT INTO download_active_leases
           (holder_id, sequence, acquired_at, renewed_at, expires_at,
            requested_start, requested_end, requested_total)
         VALUES (?, 0, ?, ?, ?, NULL, NULL, NULL)`,
        retainedHolder,
        lastActivityAt,
        lastActivityAt,
        lastActivityAt + 900_000,
      );
    });
    expect(await runDurableObjectAlarm(current.target)).toBe(true);
    const retained = await snapshot(current.target);
    expect(retained.leaseRows).toHaveLength(1);
    expect(retained.leaseRows[0]?.['holder_id']).toBe(retainedHolder);
    expect(retained.alarmAt).not.toBeNull();

    await runInDurableObject(current.target, (_instance, state) => {
      const now = Date.now();
      const lastActivityAt = now - 600_001;
      state.storage.sql.exec(
        `UPDATE download_session
         SET last_activity_at = ?, idle_expires_at = ?
         WHERE singleton = 1`,
        lastActivityAt,
        lastActivityAt + 600_000,
      );
      state.storage.sql.exec(
        `UPDATE download_active_leases
         SET acquired_at = ?, renewed_at = ?, expires_at = ?
         WHERE holder_id = ?`,
        lastActivityAt,
        lastActivityAt,
        lastActivityAt + 900_000,
        retainedHolder,
      );
    });
    expect(await runDurableObjectAlarm(current.target)).toBe(true);
    expect((await snapshot(current.target)).tables).toEqual([]);
  });

  it('fails closed and removes corrupt storage when an alarm runs', async () => {
    const current = fixture();
    expect((await initialize(current)).status).toBe(201);
    await runInDurableObject(current.target, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE download_session SET validator_value = \'W/"weak"\' WHERE singleton = 1',
      );
    });
    expect(await runDurableObjectAlarm(current.target)).toBe(true);
    expect((await snapshot(current.target)).tables).toEqual([]);
  });

  it('deletes at start and absolute deadlines and tolerates an alarm with no storage', async () => {
    const startExpired = fixture();
    expect((await initialize(startExpired)).status).toBe(201);
    await runInDurableObject(startExpired.target, (_instance, state) => {
      const issuedAt = Date.now() - 120_000;
      state.storage.sql.exec(
        `UPDATE download_session
         SET issued_at = ?, start_expires_at = ?, absolute_expires_at = ?
         WHERE singleton = 1`,
        issuedAt,
        issuedAt + 120_000,
        issuedAt + 3_600_000,
      );
    });
    expect(await runDurableObjectAlarm(startExpired.target)).toBe(true);
    expect((await snapshot(startExpired.target)).tables).toEqual([]);

    const absoluteExpired = fixture();
    expect((await initialize(absoluteExpired)).status).toBe(201);
    await runInDurableObject(absoluteExpired.target, (_instance, state) => {
      const issuedAt = Date.now() - 3_600_000;
      const absoluteExpiresAt = issuedAt + 3_600_000;
      const lastActivityAt = absoluteExpiresAt - 1;
      state.storage.sql.exec(
        `UPDATE download_session SET
           status = 'INTERRUPTED', issued_at = ?, start_expires_at = ?,
           last_activity_at = ?, idle_expires_at = ?, absolute_expires_at = ?
         WHERE singleton = 1`,
        issuedAt,
        issuedAt + 120_000,
        lastActivityAt,
        absoluteExpiresAt,
        absoluteExpiresAt,
      );
    });
    expect(await runDurableObjectAlarm(absoluteExpired.target)).toBe(true);
    expect((await snapshot(absoluteExpired.target)).tables).toEqual([]);

    const empty = fixture();
    await runInDurableObject(empty.target, (instance) => instance.alarm());
    expect((await snapshot(empty.target)).tables).toEqual([]);
  });
});
