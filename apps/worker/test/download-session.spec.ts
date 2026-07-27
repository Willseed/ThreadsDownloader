import { afterEach, describe, expect, it, vi } from 'vitest';

import { DownloadSession, type DownloadSessionEnv } from '../src/download-session.js';
import { DOWNLOAD_START_DEADLINE_MS } from '../src/security/download-session-state.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

type SqlRecord = Record<string, string | number | ArrayBuffer | null>;

const NOW = 1_000_000;
const downloadId = encodeBase64Url(new Uint8Array(24).fill(1));
const otherDownloadId = encodeBase64Url(new Uint8Array(24).fill(2));
const sessionHash = encodeBase64Url(new Uint8Array(32).fill(3));
const otherSessionHash = encodeBase64Url(new Uint8Array(32).fill(4));
const encryptionKey = encodeBase64Url(new Uint8Array(32).fill(5));
const privateUrl = 'https://video.cdninstagram.com/media/private.mp4?token=must-never-be-plaintext';

const media = {
  finalUrl: privateUrl,
  contentType: 'video/mp4',
  contentLength: 42,
  rangeCapability: 'bytes',
  strongEtag: '"download-etag"',
  lastModified: null,
  completionReliable: true,
  probeMethod: 'head',
} as const;

const initializeBody = {
  downloadId,
  sessionHash,
  filename: 'threads_Abcde_1.mp4',
  shortcode: 'Abcde',
  media,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function cursor<T extends SqlRecord>(rows: readonly T[]): { toArray(): T[] } {
  return { toArray: () => [...rows] };
}

class FakeDownloadStorage {
  readonly tables = new Set<string>();
  readonly intervals: SqlRecord[] = [];
  readonly leases: SqlRecord[] = [];
  row: SqlRecord | null = null;
  alarmAt: number | null = null;
  totalChanges = 0;
  failSetAlarm = false;
  failSetAlarmOnce = false;
  failDeleteAllOnce = false;

  readonly sql = {
    // The fake deliberately dispatches every SQL statement through the same Cloudflare-like seam.
    // eslint-disable-next-line sonarjs/cognitive-complexity
    exec: vi.fn((query: string, ...bindings: (string | number | null)[]) => {
      const normalized = query.replaceAll(/\s+/gu, ' ').trim();
      const create = /^CREATE TABLE IF NOT EXISTS ([a-z_]+)/u.exec(normalized);
      if (create !== null) {
        this.tables.add(create[1]!);
        return cursor([]);
      }
      if (normalized.startsWith('SELECT name FROM sqlite_schema')) {
        return cursor(
          bindings.flatMap((name) =>
            typeof name === 'string' && this.tables.has(name) ? [{ name }] : [],
          ),
        );
      }
      if (normalized === 'SELECT singleton FROM download_session WHERE singleton = 1') {
        return cursor(this.row === null ? [] : [{ singleton: 1 }]);
      }
      if (normalized.startsWith('INSERT INTO download_session')) {
        const [
          storedDownloadId,
          storedSessionHash,
          filename,
          shortcode,
          sealedMedia,
          contentType,
          contentLength,
          strongEtag,
          lastModified,
          rangeCapability,
          validatorKind,
          validatorValue,
          status,
          issuedAt,
          startExpiresAt,
          lastActivityAt,
          idleExpiresAt,
          absoluteExpiresAt,
          completionExpiresAt,
        ] = bindings;
        this.row = {
          schema_version: 1,
          download_id: storedDownloadId!,
          session_hash: storedSessionHash!,
          filename: filename!,
          shortcode: shortcode!,
          sealed_media: sealedMedia!,
          content_type: contentType!,
          content_length: contentLength!,
          strong_etag: strongEtag!,
          last_modified: lastModified!,
          range_capability: rangeCapability!,
          validator_kind: validatorKind!,
          validator_value: validatorValue!,
          status: status!,
          issued_at: issuedAt!,
          start_expires_at: startExpiresAt!,
          last_activity_at: lastActivityAt!,
          idle_expires_at: idleExpiresAt!,
          absolute_expires_at: absoluteExpiresAt!,
          completion_expires_at: completionExpiresAt!,
        };
        this.totalChanges += 1;
        return cursor([]);
      }
      if (normalized.startsWith('UPDATE download_session SET last_activity_at = ?')) {
        if (
          this.row === null ||
          this.row['status'] !== 'ACTIVE' ||
          this.row['last_activity_at'] !== bindings[2] ||
          this.row['idle_expires_at'] !== bindings[3]
        ) {
          return cursor([]);
        }
        this.row['last_activity_at'] = bindings[0]!;
        this.row['idle_expires_at'] = bindings[1]!;
        this.totalChanges += 1;
        return cursor([{ singleton: 1 }]);
      }
      if (normalized.startsWith('UPDATE download_session SET')) {
        if (this.row === null) {
          return cursor([]);
        }
        const [
          status,
          issuedAt,
          startExpiresAt,
          lastActivityAt,
          idleExpiresAt,
          absoluteExpiresAt,
          completionExpiresAt,
          contentLength,
          validatorKind,
          validatorValue,
        ] = bindings;
        Object.assign(this.row, {
          status,
          issued_at: issuedAt,
          start_expires_at: startExpiresAt,
          last_activity_at: lastActivityAt,
          idle_expires_at: idleExpiresAt,
          absolute_expires_at: absoluteExpiresAt,
          completion_expires_at: completionExpiresAt,
          content_length: contentLength,
          validator_kind: validatorKind,
          validator_value: validatorValue,
        });
        this.totalChanges += 1;
        return cursor([]);
      }
      if (normalized === 'DELETE FROM download_completed_intervals') {
        this.totalChanges += this.intervals.length;
        this.intervals.length = 0;
        return cursor([]);
      }
      if (normalized.startsWith('INSERT INTO download_completed_intervals')) {
        const [start, end, total] = bindings;
        this.intervals.push({ start_byte: start!, end_byte: end!, total_bytes: total! });
        this.totalChanges += 1;
        return cursor([]);
      }
      if (normalized === 'DELETE FROM download_active_leases') {
        this.totalChanges += this.leases.length;
        this.leases.length = 0;
        return cursor([]);
      }
      if (normalized.startsWith('INSERT INTO download_active_leases')) {
        const [
          holderId,
          sequence,
          acquiredAt,
          renewedAt,
          expiresAt,
          requestedStart,
          requestedEnd,
          requestedTotal,
        ] = bindings;
        this.leases.push({
          holder_id: holderId!,
          sequence: sequence!,
          acquired_at: acquiredAt!,
          renewed_at: renewedAt!,
          expires_at: expiresAt!,
          requested_start: requestedStart!,
          requested_end: requestedEnd!,
          requested_total: requestedTotal!,
        });
        this.totalChanges += 1;
        return cursor([]);
      }
      if (normalized.startsWith('UPDATE download_active_leases SET sequence = ?')) {
        const [
          sequence,
          renewedAt,
          expiresAt,
          holderId,
          previousSequence,
          acquiredAt,
          previousRenewedAt,
          previousExpiresAt,
          requestedStart,
          requestedEnd,
          requestedTotal,
        ] = bindings;
        const lease = this.leases.find(
          (candidate) =>
            candidate['holder_id'] === holderId &&
            candidate['sequence'] === previousSequence &&
            candidate['acquired_at'] === acquiredAt &&
            candidate['renewed_at'] === previousRenewedAt &&
            candidate['expires_at'] === previousExpiresAt &&
            candidate['requested_start'] === requestedStart &&
            candidate['requested_end'] === requestedEnd &&
            candidate['requested_total'] === requestedTotal,
        );
        if (lease === undefined) {
          return cursor([]);
        }
        lease['sequence'] = sequence!;
        lease['renewed_at'] = renewedAt!;
        lease['expires_at'] = expiresAt!;
        this.totalChanges += 1;
        return cursor([{ holder_id: holderId! }]);
      }
      if (
        normalized ===
        'DELETE FROM download_active_leases WHERE expires_at <= ? RETURNING holder_id'
      ) {
        const expiresAt = bindings[0];
        const deleted =
          typeof expiresAt === 'number'
            ? this.leases.filter(
                (lease) =>
                  typeof lease['expires_at'] === 'number' && lease['expires_at'] <= expiresAt,
              )
            : [];
        this.leases.splice(
          0,
          this.leases.length,
          ...this.leases.filter((lease) => !deleted.includes(lease)),
        );
        this.totalChanges += deleted.length;
        return cursor(deleted.map((lease) => ({ holder_id: lease['holder_id']! })));
      }
      if (normalized.startsWith('SELECT MIN(absolute_expires_at, idle_expires_at,')) {
        const deadlines = this.leases.map((lease) => lease['expires_at']);
        if (this.row === null || this.row['status'] !== 'ACTIVE') {
          return cursor([]);
        }
        const absoluteExpiresAt = this.row['absolute_expires_at'];
        const idleExpiresAt = this.row['idle_expires_at'];
        const allDeadlines = [absoluteExpiresAt, idleExpiresAt, ...deadlines];
        return cursor([
          {
            alarm_at: allDeadlines.every((deadline) => typeof deadline === 'number')
              ? Math.min(...(allDeadlines as number[]))
              : null,
          },
        ]);
      }
      if (normalized.includes('FROM download_session WHERE singleton = 1')) {
        return cursor(this.row === null ? [] : [this.row]);
      }
      if (normalized.includes('FROM download_completed_intervals')) {
        if (!this.tables.has('download_completed_intervals')) {
          throw new Error('no such table: download_completed_intervals');
        }
        return cursor(this.intervals);
      }
      if (normalized.includes('FROM download_active_leases')) {
        if (!this.tables.has('download_active_leases')) {
          throw new Error('no such table: download_active_leases');
        }
        return cursor(this.leases);
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    }),
  };

  readonly transactionSync = <T>(callback: () => T): T => callback();

  readonly setAlarm = vi.fn(async (timestamp: number): Promise<void> => {
    if (this.failSetAlarm || this.failSetAlarmOnce) {
      this.failSetAlarmOnce = false;
      throw new Error('alarm unavailable');
    }
    this.alarmAt = timestamp;
  });

  readonly deleteAlarm = vi.fn(async (): Promise<void> => {
    this.alarmAt = null;
  });

  readonly deleteAll = vi.fn(async (): Promise<void> => {
    if (this.failDeleteAllOnce) {
      this.failDeleteAllOnce = false;
      throw new Error('storage unavailable');
    }
    this.tables.clear();
    this.row = null;
    this.intervals.length = 0;
    this.leases.length = 0;
  });
}

function object(
  storage = new FakeDownloadStorage(),
  key = encryptionKey,
): {
  readonly session: DownloadSession;
  readonly storage: FakeDownloadStorage;
} {
  return {
    session: new DownloadSession(
      {
        storage,
        blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => callback(),
      } as unknown as DurableObjectState,
      { DOWNLOAD_ENCRYPTION_KEY: key } as DownloadSessionEnv,
    ),
    storage,
  };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://download.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function headRequest(id = downloadId, hash = sessionHash, path = '/inspect'): Request {
  return new Request(`https://download.internal${path}`, {
    method: 'HEAD',
    headers: { 'x-download-id': id, 'x-session-hash': hash },
  });
}

async function initialize(
  session: DownloadSession,
  body: unknown = initializeBody,
): Promise<Response> {
  return session.fetch(jsonRequest('/initialize', body));
}

async function acquire(
  session: DownloadSession,
  rangeHeader: string | null = null,
  ifRangeHeader: string | null = null,
): Promise<Response> {
  return session.fetch(
    jsonRequest('/acquire', { downloadId, sessionHash, rangeHeader, ifRangeHeader }),
  );
}

async function finish(
  session: DownloadSession,
  holderId: string,
  input: {
    readonly actualBytes?: number;
    readonly status?: 200 | 206;
    readonly contentLength?: string | null;
    readonly contentRange?: string | null;
  } = {},
): Promise<Response> {
  return session.fetch(
    jsonRequest('/finish', {
      downloadId,
      sessionHash,
      holderId,
      sequence: 0,
      normalEof: true,
      actualBytes: input.actualBytes ?? 42,
      upstream: {
        status: input.status ?? 200,
        headers: {
          contentLength: input.contentLength ?? '42',
          contentRange: input.contentRange ?? null,
          etag: media.strongEtag,
          lastModified: null,
        },
      },
    }),
  );
}

describe('DownloadSession initialize seam', () => {
  it('performs no storage operation in the constructor and seals before creating tables', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect(storage.sql.exec).not.toHaveBeenCalled();

    const response = await initialize(session);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      issuedAt: NOW,
      startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS,
      absoluteExpiresAt: NOW + 3_600_000,
    });
    expect(storage.tables).toEqual(
      new Set(['download_session', 'download_completed_intervals', 'download_active_leases']),
    );
    expect(storage.totalChanges).toBe(1);
    expect(storage.alarmAt).toBe(NOW + DOWNLOAD_START_DEADLINE_MS);
    expect(storage.row).toMatchObject({
      download_id: downloadId,
      session_hash: sessionHash,
      filename: initializeBody.filename,
      shortcode: initializeBody.shortcode,
      content_type: media.contentType,
      content_length: media.contentLength,
      strong_etag: media.strongEtag,
      range_capability: media.rangeCapability,
      status: 'ISSUED',
    });
    expect(storage.row?.['sealed_media']).not.toBe(privateUrl);
    expect(JSON.stringify(storage.row)).not.toContain(privateUrl);
    expect(JSON.stringify(storage.row)).not.toContain('must-never-be-plaintext');

    const duplicate = await initialize(session);
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ ok: false });
    expect(storage.totalChanges).toBe(1);
  });

  it('uses fixed safe routing/input failures without creating storage', async () => {
    const { session, storage } = object();
    const wrongQuery = await session.fetch(jsonRequest('/initialize?now=1', initializeBody));
    expect(wrongQuery.status).toBe(404);
    await expect(wrongQuery.json()).resolves.toEqual({ ok: false });

    const wrongContentType = await session.fetch(
      new Request('https://download.internal/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(initializeBody),
      }),
    );
    expect(wrongContentType.status).toBe(400);
    expect(storage.tables.size).toBe(0);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it('deletes all persisted data when scheduling the initial alarm fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const storage = new FakeDownloadStorage();
    storage.failSetAlarm = true;
    const { session } = object(storage);
    const response = await initialize(session);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(storage.deleteAll).toHaveBeenCalledOnce();
    expect(storage.tables.size).toBe(0);
    expect(storage.row).toBeNull();
  });

  it('retains an immediate cleanup alarm when initial alarm cleanup transiently fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const storage = new FakeDownloadStorage();
    storage.failSetAlarmOnce = true;
    storage.failDeleteAllOnce = true;
    const { session } = object(storage);

    const response = await initialize(session);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(storage.row).not.toBeNull();
    expect(storage.alarmAt).toBe(NOW);
    expect(storage.deleteAlarm).not.toHaveBeenCalled();

    await session.alarm();
    expect(storage.tables.size).toBe(0);
    expect(storage.row).toBeNull();
    expect(storage.alarmAt).toBeNull();
  });

  it('does not create tables on seal failure or touch the codec for a duplicate', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const failedStorage = new FakeDownloadStorage();
    const failed = object(failedStorage, 'invalid-key').session;
    const failedResponse = await initialize(failed);
    expect(failedResponse.status).toBe(500);
    expect(failedStorage.tables.size).toBe(0);
    expect(failedStorage.totalChanges).toBe(0);

    const storage = new FakeDownloadStorage();
    expect((await initialize(object(storage).session)).status).toBe(201);
    const duplicate = await initialize(object(storage, 'invalid-key').session);
    expect(duplicate.status).toBe(409);
    expect(storage.totalChanges).toBe(1);
  });
});

describe('DownloadSession read-only seams', () => {
  it('returns 410 for fresh unknown HEAD/status without creating tables or alarms', async () => {
    const { session, storage } = object();
    const head = await session.fetch(headRequest());
    expect(head.status).toBe(410);
    await expect(head.text()).resolves.toBe('');
    const status = await session.fetch(jsonRequest('/status', { downloadId, sessionHash }));
    expect(status.status).toBe(410);
    await expect(status.json()).resolves.toEqual({ ok: false });
    expect(storage.tables.size).toBe(0);
    expect(storage.totalChanges).toBe(0);
    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });

  it('inspects an initialized row without changing rows or alarms', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const rowBefore = structuredClone(storage.row);
    const alarmBefore = storage.alarmAt;
    storage.setAlarm.mockClear();

    const head = await session.fetch(headRequest());
    expect(head.status).toBe(200);
    expect(head.headers.get('x-download-filename')).toBe(initializeBody.filename);
    expect(head.headers.get('content-type')).toBe(media.contentType);
    expect(head.headers.get('content-length')).toBe(String(media.contentLength));
    expect(head.headers.get('etag')).toBe(media.strongEtag);
    expect(head.headers.get('last-modified')).toBeNull();
    expect(head.headers.get('x-download-range-capability')).toBe(media.rangeCapability);
    await expect(head.text()).resolves.toBe('');
    const response = await session.fetch(jsonRequest('/status', { downloadId, sessionHash }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      filename: initializeBody.filename,
      contentType: media.contentType,
      contentLength: media.contentLength,
      strongEtag: media.strongEtag,
      lastModified: media.lastModified,
      rangeCapability: media.rangeCapability,
      status: 'ISSUED',
      available: true,
      startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS,
      idleExpiresAt: null,
      absoluteExpiresAt: NOW + 3_600_000,
      completionExpiresAt: null,
      activeStreams: 0,
    });
    expect(storage.row).toEqual(rowBefore);
    expect(storage.alarmAt).toBe(alarmBefore);
    expect(storage.totalChanges).toBe(1);
    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });

  it('returns fixed mismatch, expiry, malformed-identity, and corruption responses', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);

    expect((await session.fetch(headRequest(otherDownloadId, sessionHash))).status).toBe(401);
    const mismatch = await session.fetch(
      jsonRequest('/status', { downloadId, sessionHash: otherSessionHash }),
    );
    expect(mismatch.status).toBe(401);
    await expect(mismatch.json()).resolves.toEqual({ ok: false });

    expect((await session.fetch(headRequest('invalid', sessionHash))).status).toBe(400);
    const extra = await session.fetch(
      jsonRequest('/status', { downloadId, sessionHash, now: NOW }),
    );
    expect(extra.status).toBe(400);

    vi.spyOn(Date, 'now').mockReturnValue(NOW + DOWNLOAD_START_DEADLINE_MS);
    expect((await session.fetch(headRequest())).status).toBe(410);
    expect((await session.fetch(jsonRequest('/status', { downloadId, sessionHash }))).status).toBe(
      410,
    );

    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    storage.row!['schema_version'] = 2;
    expect((await session.fetch(headRequest())).status).toBe(500);
    const corrupt = await session.fetch(jsonRequest('/status', { downloadId, sessionHash }));
    expect(corrupt.status).toBe(500);
    await expect(corrupt.json()).resolves.toEqual({ ok: false });
  });
});

describe('DownloadSession lifecycle seams', () => {
  it('decrypts only for acquire, separates lease heartbeats from byte activity, and interrupts', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);

    const first = await acquire(session);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      readonly holderId: string;
      readonly sequence: number;
      readonly media: { readonly finalUrl: string };
    };
    expect(firstBody.sequence).toBe(0);
    expect(firstBody.media.finalUrl).toBe(privateUrl);
    expect(JSON.stringify(storage.row)).not.toContain(privateUrl);
    expect(storage.leases).toHaveLength(1);

    clock.mockReturnValue(NOW + 1);
    const missingProgress = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: firstBody.holderId,
        sequence: 1,
      }),
    );
    expect(missingProgress.status).toBe(400);
    expect(storage.row).toMatchObject({
      last_activity_at: NOW,
      idle_expires_at: NOW + 600_000,
    });

    const renewed = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: firstBody.holderId,
        sequence: 1,
        progress: false,
      }),
    );
    expect(renewed.status).toBe(200);
    await expect(renewed.json()).resolves.toMatchObject({
      ok: true,
      holderId: firstBody.holderId,
      sequence: 1,
    });
    expect(storage.row).toMatchObject({
      last_activity_at: NOW,
      idle_expires_at: NOW + 600_000,
    });
    expect(storage.leases[0]).toMatchObject({
      sequence: 1,
      renewed_at: NOW + 1,
      expires_at: NOW + 1 + 900_000,
    });
    expect(storage.alarmAt).toBe(NOW + 600_000);

    clock.mockReturnValue(NOW + 2);
    const changesBeforeProgress = storage.totalChanges;
    storage.sql.exec.mockClear();
    const progressed = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: firstBody.holderId,
        sequence: 2,
        progress: true,
      }),
    );
    expect(progressed.status).toBe(200);
    expect(storage.row).toMatchObject({
      last_activity_at: NOW + 2,
      idle_expires_at: NOW + 2 + 600_000,
    });
    expect(storage.sql.exec).toHaveBeenCalledTimes(7);
    expect(storage.totalChanges - changesBeforeProgress).toBe(2);
    expect(storage.alarmAt).toBe(NOW + 2 + 600_000);

    const replay = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: firstBody.holderId,
        sequence: 2,
        progress: true,
      }),
    );
    expect(replay.status).toBe(409);
    const interrupted = await session.fetch(
      jsonRequest('/interrupt', {
        downloadId,
        sessionHash,
        holderId: firstBody.holderId,
        sequence: 2,
      }),
    );
    expect(interrupted.status).toBe(200);
    expect(storage.row?.['status']).toBe('INTERRUPTED');
    expect(storage.leases).toEqual([]);

    clock.mockReturnValue(NOW + 3);
    const secondBody = (await (await acquire(session)).json()) as { readonly holderId: string };
    expect(secondBody.holderId).not.toBe(firstBody.holderId);
  });

  it('deletes a blocked stream at the original idle alarm despite a fresh lease heartbeat', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const acquired = (await (await acquire(session)).json()) as { readonly holderId: string };

    clock.mockReturnValue(NOW + 599_999);
    expect(
      (
        await session.fetch(
          jsonRequest('/renew', {
            downloadId,
            sessionHash,
            holderId: acquired.holderId,
            sequence: 1,
            progress: false,
          }),
        )
      ).status,
    ).toBe(200);
    expect(storage.leases[0]).toMatchObject({
      sequence: 1,
      renewed_at: NOW + 599_999,
      expires_at: NOW + 1_499_999,
    });
    expect(storage.alarmAt).toBe(NOW + 600_000);

    clock.mockReturnValue(NOW + 600_000);
    await session.alarm();
    expect(storage.tables.size).toBe(0);
    expect(storage.row).toBeNull();
    expect(storage.leases).toEqual([]);
    expect(storage.alarmAt).toBeNull();
  });

  it('renews bounded maximum state without rewriting unrelated rows', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);

    const holders: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await acquire(session);
      expect(response.status).toBe(201);
      holders.push(((await response.json()) as { readonly holderId: string }).holderId);
    }
    storage.row!['content_length'] = 128;
    for (let index = 0; index < 64; index += 1) {
      storage.intervals.push({
        start_byte: index * 2,
        end_byte: index * 2,
        total_bytes: 128,
      });
    }
    const intervalsBefore = structuredClone(storage.intervals);
    const peerLeasesBefore = structuredClone(
      storage.leases.filter((lease) => lease['holder_id'] !== holders[0]),
    );
    const changesBefore = storage.totalChanges;
    storage.sql.exec.mockClear();

    clock.mockReturnValue(NOW + 1);
    const renewed = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: holders[0],
        sequence: 1,
        progress: false,
      }),
    );

    expect(renewed.status).toBe(200);
    expect(storage.sql.exec).toHaveBeenCalledTimes(6);
    expect(storage.totalChanges - changesBefore).toBe(1);
    expect(storage.intervals).toEqual(intervalsBefore);
    expect(storage.leases.filter((lease) => lease['holder_id'] !== holders[0])).toEqual(
      peerLeasesBefore,
    );
    expect(storage.leases.find((lease) => lease['holder_id'] === holders[0])).toMatchObject({
      sequence: 1,
      renewed_at: NOW + 1,
      expires_at: NOW + 1 + 900_000,
    });
    const statements = storage.sql.exec.mock.calls.map(([query]) =>
      query.replaceAll(/\s+/gu, ' ').trim(),
    );
    expect(statements).not.toContain('DELETE FROM download_completed_intervals');
    expect(statements).not.toContain('DELETE FROM download_active_leases');
    expect(statements.every((statement) => !statement.startsWith('INSERT INTO'))).toBe(true);
  });

  it('distinguishes a missing session table from corrupt renewal child storage', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const acquired = (await (await acquire(session)).json()) as { readonly holderId: string };
    const rowBefore = structuredClone(storage.row);
    storage.tables.delete('download_active_leases');
    storage.setAlarm.mockClear();

    const response = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: acquired.holderId,
        sequence: 1,
        progress: false,
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(storage.row).toEqual(rowBefore);
    expect(storage.setAlarm).not.toHaveBeenCalled();

    const missingSession = object();
    expect((await initialize(missingSession.session)).status).toBe(201);
    const missingSessionLease = (await (await acquire(missingSession.session)).json()) as {
      readonly holderId: string;
    };
    missingSession.storage.tables.delete('download_session');
    missingSession.storage.setAlarm.mockClear();
    const missingSessionResponse = await missingSession.session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: missingSessionLease.holderId,
        sequence: 1,
        progress: false,
      }),
    );
    expect(missingSessionResponse.status).toBe(410);
    await expect(missingSessionResponse.json()).resolves.toEqual({ ok: false });
    expect(missingSession.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('deletes only stale peer leases while advancing activity', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const target = (await (await acquire(session)).json()) as { readonly holderId: string };
    const stale = (await (await acquire(session)).json()) as { readonly holderId: string };

    clock.mockReturnValue(NOW + 500_000);
    expect(
      (
        await session.fetch(
          jsonRequest('/renew', {
            downloadId,
            sessionHash,
            holderId: target.holderId,
            sequence: 1,
            progress: true,
          }),
        )
      ).status,
    ).toBe(200);
    const changesBefore = storage.totalChanges;
    storage.sql.exec.mockClear();

    clock.mockReturnValue(NOW + 900_000);
    const renewed = await session.fetch(
      jsonRequest('/renew', {
        downloadId,
        sessionHash,
        holderId: target.holderId,
        sequence: 2,
        progress: true,
      }),
    );

    expect(renewed.status).toBe(200);
    expect(storage.sql.exec).toHaveBeenCalledTimes(8);
    expect(storage.totalChanges - changesBefore).toBe(3);
    expect(storage.leases).toHaveLength(1);
    expect(storage.leases[0]).toMatchObject({ holder_id: target.holderId, sequence: 2 });
    expect(storage.leases.some((lease) => lease['holder_id'] === stale.holderId)).toBe(false);
    expect(storage.row).toMatchObject({
      last_activity_at: NOW + 900_000,
      idle_expires_at: NOW + 1_500_000,
    });
    expect(storage.alarmAt).toBe(NOW + 1_500_000);
  });

  it('returns canonical range failures and enforces four parallel leases', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const known = object();
    expect((await initialize(known.session)).status).toBe(201);
    const unsatisfied = await acquire(known.session, 'bytes=42-', media.strongEtag);
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get('content-range')).toBe('bytes */42');
    expect(known.storage.leases).toEqual([]);

    const nonRange = object();
    expect(
      (
        await initialize(nonRange.session, {
          ...initializeBody,
          media: { ...media, rangeCapability: 'none' },
        })
      ).status,
    ).toBe(201);
    const nonRangeBefore = {
      row: structuredClone(nonRange.storage.row),
      intervals: structuredClone(nonRange.storage.intervals),
      leases: structuredClone(nonRange.storage.leases),
      alarmAt: nonRange.storage.alarmAt,
      totalChanges: nonRange.storage.totalChanges,
    };
    const unsupported = await acquire(nonRange.session, 'bytes=0-1', media.strongEtag);
    expect(unsupported.status).toBe(416);
    expect(unsupported.headers.get('content-range')).toBe('bytes */42');
    expect({
      row: nonRange.storage.row,
      intervals: nonRange.storage.intervals,
      leases: nonRange.storage.leases,
      alarmAt: nonRange.storage.alarmAt,
      totalChanges: nonRange.storage.totalChanges,
    }).toEqual(nonRangeBefore);
    const mismatch = await acquire(nonRange.session, 'bytes=0-1', '"other"');
    expect(mismatch.status).toBe(201);
    await expect(mismatch.json()).resolves.toMatchObject({
      request: { requestedInterval: null },
    });

    const unknown = object();
    expect(
      (
        await initialize(unknown.session, {
          ...initializeBody,
          media: { ...media, contentLength: null, completionReliable: false },
        })
      ).status,
    ).toBe(201);
    const unavailable = await acquire(unknown.session, 'bytes=0-1', media.strongEtag);
    expect(unavailable.status).toBe(416);
    expect(unavailable.headers.get('content-range')).toBeNull();

    const parallel = object();
    expect((await initialize(parallel.session)).status).toBe(201);
    const holders = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const response = await acquire(parallel.session);
      expect(response.status).toBe(201);
      holders.add(((await response.json()) as { readonly holderId: string }).holderId);
    }
    expect(holders).toHaveLength(4);
    expect((await acquire(parallel.session)).status).toBe(429);
    expect(parallel.storage.leases).toHaveLength(4);
  });

  it('persists partial ranges across instances and completes only the full union', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const storage = new FakeDownloadStorage();
    const firstInstance = object(storage).session;
    expect((await initialize(firstInstance)).status).toBe(201);
    const firstAcquire = await acquire(firstInstance, 'bytes=0-20', media.strongEtag);
    const firstHolder = ((await firstAcquire.json()) as { readonly holderId: string }).holderId;

    clock.mockReturnValue(NOW + 1);
    expect(
      (
        await finish(firstInstance, firstHolder, {
          actualBytes: 21,
          status: 206,
          contentLength: '21',
          contentRange: 'bytes 0-20/42',
        })
      ).status,
    ).toBe(200);
    expect(storage.row?.['status']).toBe('INTERRUPTED');
    expect(storage.intervals).toEqual([{ start_byte: 0, end_byte: 20, total_bytes: 42 }]);

    const restarted = object(storage).session;
    clock.mockReturnValue(NOW + 2);
    const secondAcquire = await acquire(restarted, 'bytes=21-41', media.strongEtag);
    const secondHolder = ((await secondAcquire.json()) as { readonly holderId: string }).holderId;
    clock.mockReturnValue(NOW + 3);
    expect(
      (
        await finish(restarted, secondHolder, {
          actualBytes: 21,
          status: 206,
          contentLength: '21',
          contentRange: 'bytes 21-41/42',
        })
      ).status,
    ).toBe(200);
    expect(storage.row?.['status']).toBe('COMPLETE_PENDING');
    expect(storage.intervals).toEqual([{ start_byte: 0, end_byte: 41, total_bytes: 42 }]);
    expect(storage.leases).toEqual([]);
    expect(storage.alarmAt).toBe(NOW + 3 + 90_000);

    clock.mockReturnValue(NOW + 3 + 90_000);
    await restarted.alarm();
    expect(storage.tables.size).toBe(0);
    expect(storage.row).toBeNull();
  });

  it('prunes a stale lease on alarm, reschedules, then deletes at idle expiry', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const first = (await (await acquire(session)).json()) as { readonly holderId: string };

    clock.mockReturnValue(NOW + 400_000);
    const second = (await (await acquire(session)).json()) as { readonly holderId: string };
    expect(storage.leases.map((lease) => lease['holder_id'])).toEqual([
      first.holderId,
      second.holderId,
    ]);

    clock.mockReturnValue(NOW + 900_000);
    await session.alarm();
    expect(storage.row?.['status']).toBe('ACTIVE');
    expect(storage.leases.map((lease) => lease['holder_id'])).toEqual([second.holderId]);
    expect(storage.alarmAt).toBe(NOW + 1_000_000);

    clock.mockReturnValue(NOW + 1_000_000);
    await session.alarm();
    expect(storage.tables.size).toBe(0);
  });

  it('retries alarm deletion without stranding persisted storage', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);

    clock.mockReturnValue(NOW + DOWNLOAD_START_DEADLINE_MS);
    storage.alarmAt = null;
    storage.failDeleteAllOnce = true;
    await session.alarm();
    expect(storage.row).not.toBeNull();
    expect(storage.alarmAt).toBe(NOW + DOWNLOAD_START_DEADLINE_MS);
    expect(storage.deleteAlarm).not.toHaveBeenCalled();

    await session.alarm();
    expect(storage.tables.size).toBe(0);
    expect(storage.row).toBeNull();
    expect(storage.alarmAt).toBeNull();
  });

  it('destroys without decrypting, makes replay gone, and fails closed on mutation alarm errors', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    const mismatch = await session.fetch(
      jsonRequest('/destroy', { downloadId: otherDownloadId, sessionHash }),
    );
    expect(mismatch.status).toBe(401);
    const destroyed = await session.fetch(jsonRequest('/destroy', { downloadId, sessionHash }));
    expect(destroyed.status).toBe(200);
    expect(storage.tables.size).toBe(0);
    expect((await session.fetch(jsonRequest('/destroy', { downloadId, sessionHash }))).status).toBe(
      410,
    );

    const failingStorage = new FakeDownloadStorage();
    const failing = object(failingStorage).session;
    expect((await initialize(failing)).status).toBe(201);
    const failingLease = (await (await acquire(failing)).json()) as { readonly holderId: string };
    failingStorage.failSetAlarm = true;
    clock.mockReturnValue(NOW + 1);
    expect(
      (
        await failing.fetch(
          jsonRequest('/renew', {
            downloadId,
            sessionHash,
            holderId: failingLease.holderId,
            sequence: 1,
            progress: false,
          }),
        )
      ).status,
    ).toBe(500);
    expect(failingStorage.deleteAlarm).toHaveBeenCalled();
    expect(failingStorage.deleteAll).toHaveBeenCalled();
    expect(failingStorage.tables.size).toBe(0);
  });

  it('preserves a retry alarm when destroy or mutation cleanup transiently fails', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);

    const destroyStorage = new FakeDownloadStorage();
    const destroySession = object(destroyStorage).session;
    expect((await initialize(destroySession)).status).toBe(201);
    destroyStorage.failDeleteAllOnce = true;
    const failedDestroy = await destroySession.fetch(
      jsonRequest('/destroy', { downloadId, sessionHash }),
    );
    expect(failedDestroy.status).toBe(500);
    expect(destroyStorage.row).not.toBeNull();
    expect(destroyStorage.alarmAt).toBe(NOW);
    expect(destroyStorage.deleteAlarm).not.toHaveBeenCalled();
    expect(
      (await destroySession.fetch(jsonRequest('/destroy', { downloadId, sessionHash }))).status,
    ).toBe(200);
    expect(destroyStorage.tables.size).toBe(0);
    expect(destroyStorage.alarmAt).toBeNull();

    const mutationStorage = new FakeDownloadStorage();
    const mutationSession = object(mutationStorage).session;
    expect((await initialize(mutationSession)).status).toBe(201);
    mutationStorage.failSetAlarmOnce = true;
    mutationStorage.failDeleteAllOnce = true;
    clock.mockReturnValue(NOW + 1);
    const failedMutation = await acquire(mutationSession);
    expect(failedMutation.status).toBe(500);
    expect(mutationStorage.row).not.toBeNull();
    expect(mutationStorage.leases).toHaveLength(1);
    expect(mutationStorage.alarmAt).toBe(NOW + 1);
    expect(mutationStorage.deleteAlarm).not.toHaveBeenCalled();

    await mutationSession.alarm();
    expect(mutationStorage.tables.size).toBe(0);
    expect(mutationStorage.row).toBeNull();
    expect(mutationStorage.alarmAt).toBeNull();
  });

  it('uses the server clock and rejects client-supplied holder or time fields', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { session, storage } = object();
    expect((await initialize(session)).status).toBe(201);
    clock.mockReturnValue(NOW + 77);
    expect(
      (
        await session.fetch(
          jsonRequest('/acquire', {
            downloadId,
            sessionHash,
            rangeHeader: null,
            ifRangeHeader: null,
            now: 1,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await session.fetch(
          jsonRequest('/acquire', {
            downloadId,
            sessionHash,
            rangeHeader: null,
            ifRangeHeader: null,
            holderId: encodeBase64Url(new Uint8Array(24).fill(9)),
          }),
        )
      ).status,
    ).toBe(400);
    const acquired = await acquire(session);
    expect(acquired.status).toBe(201);
    expect(storage.row?.['last_activity_at']).toBe(NOW + 77);
    expect(storage.leases[0]?.['acquired_at']).toBe(NOW + 77);
  });
});
