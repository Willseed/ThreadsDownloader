import { DurableObject } from 'cloudflare:workers';

import {
  decodeDownloadSessionAcquireRequest,
  decodeDownloadSessionFinishRequest,
  decodeDownloadSessionIdentityRequest,
  decodeDownloadSessionInitializeRequest,
  decodeDownloadSessionInterruptRequest,
  decodeDownloadSessionRenewRequest,
  downloadHeaderEvidenceSource,
  type DownloadSessionFinishRequest,
  type DownloadSessionIdentityRequest,
  type DownloadSessionInitializeRequest,
  type DownloadSessionInterruptRequest,
} from './security/download-session-client.js';
import { createOpaqueId } from './security/cryptography.js';
import {
  createDownloadMediaCodec,
  type DownloadMediaBinding,
  type DownloadMediaCodec,
} from './security/download-media-codec.js';
import {
  acquireDownloadStream,
  decideDownloadAlarm,
  DownloadSessionStateError,
  finishDownloadStream,
  inspectDownloadSession,
  interruptDownloadStream,
  issueDownloadSession,
  renewDownloadStream,
  type DownloadSessionInspection,
  type DownloadSessionState,
  type DownloadStreamLease,
  type RenewDownloadStreamResult,
} from './security/download-session-state.js';
import {
  decideIfRange,
  inspectRepresentationHeaders,
  RangeTransferError,
  type ByteInterval,
  type ReliableValidator,
} from './security/range-transfer.js';
import { encodeProbedMediaWire } from './security/resolve-vault.js';

const sessionTableSql = `CREATE TABLE IF NOT EXISTS download_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  download_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  shortcode TEXT NOT NULL,
  sealed_media TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_length INTEGER CHECK (content_length IS NULL OR content_length > 0),
  strong_etag TEXT,
  last_modified TEXT,
  range_capability TEXT NOT NULL CHECK (range_capability IN ('bytes', 'none', 'unknown')),
  validator_kind TEXT CHECK (validator_kind IS NULL OR validator_kind IN ('etag', 'last-modified')),
  validator_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('ISSUED', 'ACTIVE', 'INTERRUPTED', 'COMPLETE_PENDING')),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  start_expires_at INTEGER NOT NULL CHECK (start_expires_at > issued_at),
  last_activity_at INTEGER CHECK (last_activity_at IS NULL OR last_activity_at >= issued_at),
  idle_expires_at INTEGER CHECK (idle_expires_at IS NULL OR idle_expires_at > issued_at),
  absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at > issued_at),
  completion_expires_at INTEGER CHECK (completion_expires_at IS NULL OR completion_expires_at > issued_at),
  CHECK ((validator_kind IS NULL) = (validator_value IS NULL)),
  CHECK ((last_activity_at IS NULL) = (idle_expires_at IS NULL))
)`;

const completedIntervalsTableSql = `CREATE TABLE IF NOT EXISTS download_completed_intervals (
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  PRIMARY KEY (start_byte, end_byte, total_bytes),
  CHECK (start_byte >= 0),
  CHECK (end_byte >= start_byte),
  CHECK (total_bytes > 0),
  CHECK (end_byte < total_bytes)
)`;

const activeLeasesTableSql = `CREATE TABLE IF NOT EXISTS download_active_leases (
  holder_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
  renewed_at INTEGER NOT NULL CHECK (renewed_at >= acquired_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at),
  requested_start INTEGER,
  requested_end INTEGER,
  requested_total INTEGER,
  CHECK ((requested_start IS NULL) = (requested_end IS NULL)),
  CHECK ((requested_start IS NULL) = (requested_total IS NULL)),
  CHECK (requested_start IS NULL OR requested_start >= 0),
  CHECK (requested_start IS NULL OR requested_end >= requested_start),
  CHECK (requested_start IS NULL OR requested_total > 0),
  CHECK (requested_start IS NULL OR requested_end < requested_total)
)`;

export interface DownloadSessionEnv {
  readonly DOWNLOAD_ENCRYPTION_KEY: string;
}

type SqlValue = string | number | ArrayBuffer | null;

interface SessionRow {
  readonly [key: string]: SqlValue;
  readonly schema_version: SqlValue;
  readonly download_id: SqlValue;
  readonly session_hash: SqlValue;
  readonly filename: SqlValue;
  readonly shortcode: SqlValue;
  readonly sealed_media: SqlValue;
  readonly content_type: SqlValue;
  readonly content_length: SqlValue;
  readonly strong_etag: SqlValue;
  readonly last_modified: SqlValue;
  readonly range_capability: SqlValue;
  readonly validator_kind: SqlValue;
  readonly validator_value: SqlValue;
  readonly status: SqlValue;
  readonly issued_at: SqlValue;
  readonly start_expires_at: SqlValue;
  readonly last_activity_at: SqlValue;
  readonly idle_expires_at: SqlValue;
  readonly absolute_expires_at: SqlValue;
  readonly completion_expires_at: SqlValue;
}

interface IntervalRow {
  readonly [key: string]: SqlValue;
  readonly start_byte: SqlValue;
  readonly end_byte: SqlValue;
  readonly total_bytes: SqlValue;
}

interface LeaseRow {
  readonly [key: string]: SqlValue;
  readonly holder_id: SqlValue;
  readonly sequence: SqlValue;
  readonly acquired_at: SqlValue;
  readonly renewed_at: SqlValue;
  readonly expires_at: SqlValue;
  readonly requested_start: SqlValue;
  readonly requested_end: SqlValue;
  readonly requested_total: SqlValue;
}

interface AlarmDeadlineRow {
  readonly [key: string]: SqlValue;
  readonly alarm_at: SqlValue;
}

interface PersistedDownloadSession {
  readonly downloadId: string;
  readonly sessionHash: string;
  readonly filename: string;
  readonly shortcode: string;
  readonly sealedMedia: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly rangeCapability: 'bytes' | 'none' | 'unknown';
  readonly state: DownloadSessionState;
}

type PersistedSessionInspectionResult =
  | {
      readonly status: 200;
      readonly session: PersistedDownloadSession;
      readonly inspection: DownloadSessionInspection;
    }
  | { readonly status: 401 | 410 | 500 };

const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/u;
const VIDEO_MEDIA_TYPE = /^video\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;
const SESSION_ROW_COLUMNS = `schema_version, download_id, session_hash, filename, shortcode,
  sealed_media, content_type, content_length, strong_etag, last_modified, range_capability,
  validator_kind, validator_value, status, issued_at, start_expires_at, last_activity_at,
  idle_expires_at, absolute_expires_at, completion_expires_at`;

function corruptStorage(): never {
  throw new Error('Stored download session is invalid.');
}

function isSafeInteger(value: SqlValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNullableSafeInteger(value: SqlValue): value is number | null {
  return value === null || isSafeInteger(value);
}

function isNullableString(value: SqlValue): value is string | null {
  return value === null || typeof value === 'string';
}

function isPersistedStatus(
  value: SqlValue,
): value is 'ISSUED' | 'ACTIVE' | 'INTERRUPTED' | 'COMPLETE_PENDING' {
  return (
    value === 'ISSUED' ||
    value === 'ACTIVE' ||
    value === 'INTERRUPTED' ||
    value === 'COMPLETE_PENDING'
  );
}

function isRangeCapability(value: SqlValue): value is 'bytes' | 'none' | 'unknown' {
  return value === 'bytes' || value === 'none' || value === 'unknown';
}

function sameValidator(left: ReliableValidator | null, kind: SqlValue, value: SqlValue): boolean {
  if (left === null) {
    return kind === null && value === null;
  }
  return kind === left.kind && value === left.value;
}

function restoreRepresentation(row: SessionRow): {
  readonly total: number | null;
  readonly validator: ReliableValidator | null;
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
} {
  const contentLength = row.content_length;
  const strongEtag = row.strong_etag;
  const lastModified = row.last_modified;
  if (
    !isNullableSafeInteger(contentLength) ||
    !isNullableString(strongEtag) ||
    !isNullableString(lastModified)
  ) {
    return corruptStorage();
  }
  let inspected;
  try {
    inspected = inspectRepresentationHeaders({
      get(name): string | null {
        if (name.toLowerCase() === 'content-length') {
          return contentLength === null ? null : String(contentLength);
        }
        if (name.toLowerCase() === 'etag') {
          return strongEtag;
        }
        if (name.toLowerCase() === 'last-modified') {
          return lastModified;
        }
        return null;
      },
    });
  } catch {
    return corruptStorage();
  }
  if (
    inspected.contentLength !== contentLength ||
    (inspected.strongEtag?.value ?? null) !== strongEtag ||
    (inspected.lastModified?.value ?? null) !== lastModified ||
    !sameValidator(inspected.validator, row.validator_kind, row.validator_value)
  ) {
    return corruptStorage();
  }
  return { total: contentLength, validator: inspected.validator, strongEtag, lastModified };
}

function restoreIntervals(rows: readonly IntervalRow[]): readonly ByteInterval[] {
  return rows.map((row) => {
    if (
      !isSafeInteger(row.start_byte) ||
      !isSafeInteger(row.end_byte) ||
      !isSafeInteger(row.total_bytes)
    ) {
      return corruptStorage();
    }
    return { start: row.start_byte, end: row.end_byte, total: row.total_bytes };
  });
}

function restoreLeases(rows: readonly LeaseRow[]): readonly DownloadStreamLease[] {
  return rows.map((row) => {
    if (
      typeof row.holder_id !== 'string' ||
      !isSafeInteger(row.sequence) ||
      !isSafeInteger(row.acquired_at) ||
      !isSafeInteger(row.renewed_at) ||
      !isSafeInteger(row.expires_at)
    ) {
      return corruptStorage();
    }
    const requestedStart = row.requested_start;
    const requestedEnd = row.requested_end;
    const requestedTotal = row.requested_total;
    let requestedInterval: ByteInterval | null = null;
    if (requestedStart !== null || requestedEnd !== null || requestedTotal !== null) {
      if (
        !isSafeInteger(requestedStart) ||
        !isSafeInteger(requestedEnd) ||
        !isSafeInteger(requestedTotal)
      ) {
        return corruptStorage();
      }
      requestedInterval = {
        start: requestedStart,
        end: requestedEnd,
        total: requestedTotal,
      };
    }
    return {
      holderId: row.holder_id,
      sequence: row.sequence,
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      expiresAt: row.expires_at,
      requestedInterval,
    };
  });
}

function restorePersistedSession(
  row: SessionRow,
  intervalRows: readonly IntervalRow[],
  leaseRows: readonly LeaseRow[],
): PersistedDownloadSession {
  const identity = decodeDownloadSessionIdentityRequest({
    downloadId: row.download_id,
    sessionHash: row.session_hash,
  });
  if (
    row.schema_version !== 1 ||
    identity === null ||
    typeof row.filename !== 'string' ||
    row.filename.length > 128 ||
    !SAFE_FILENAME.test(row.filename) ||
    typeof row.shortcode !== 'string' ||
    !SAFE_SHORTCODE.test(row.shortcode) ||
    typeof row.sealed_media !== 'string' ||
    row.sealed_media.length === 0 ||
    row.sealed_media.length > 12_000 ||
    typeof row.content_type !== 'string' ||
    !VIDEO_MEDIA_TYPE.test(row.content_type) ||
    !isRangeCapability(row.range_capability) ||
    !isPersistedStatus(row.status) ||
    !isSafeInteger(row.issued_at) ||
    !isSafeInteger(row.start_expires_at) ||
    !isNullableSafeInteger(row.last_activity_at) ||
    !isNullableSafeInteger(row.idle_expires_at) ||
    !isSafeInteger(row.absolute_expires_at) ||
    !isNullableSafeInteger(row.completion_expires_at)
  ) {
    return corruptStorage();
  }
  const representation = restoreRepresentation(row);
  const state: DownloadSessionState = {
    status: row.status,
    issuedAt: row.issued_at,
    startExpiresAt: row.start_expires_at,
    lastActivityAt: row.last_activity_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    completionExpiresAt: row.completion_expires_at,
    representation: { total: representation.total, validator: representation.validator },
    completedIntervals: restoreIntervals(intervalRows),
    leases: restoreLeases(leaseRows),
  };
  return {
    downloadId: identity.downloadId,
    sessionHash: identity.sessionHash,
    filename: row.filename,
    shortcode: row.shortcode,
    sealedMedia: row.sealed_media,
    contentType: row.content_type,
    contentLength: representation.total,
    strongEtag: representation.strongEtag,
    lastModified: representation.lastModified,
    rangeCapability: row.range_capability,
    state,
  };
}

function safeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function rangeFailure(contentRange?: string): Response {
  const headers = new Headers();
  if (contentRange !== undefined) {
    headers.set('content-range', contentRange);
  }
  return Response.json({ ok: false }, { status: 416, headers });
}

function operationErrorResponse(error: unknown): Response {
  if (error instanceof RangeTransferError) {
    if (error.code === 'RANGE_INVALID' || error.code === 'RANGE_NOT_SATISFIABLE') {
      return rangeFailure(error.contentRange);
    }
    return error.code === 'INTERVAL_LIMIT'
      ? safeJson(409, { ok: false })
      : safeJson(500, { ok: false });
  }
  if (error instanceof DownloadSessionStateError) {
    if (error.code === 'DOWNLOAD_CONCURRENT_LIMIT') {
      return safeJson(429, { ok: false });
    }
    if (error.code === 'DOWNLOAD_EXPIRED') {
      return safeJson(410, { ok: false });
    }
    if (error.code === 'DOWNLOAD_RANGE_UNAVAILABLE') {
      return rangeFailure();
    }
    if (error.code === 'DOWNLOAD_LEASE_INVALID' || error.code === 'DOWNLOAD_SEQUENCE_INVALID') {
      return safeJson(409, { ok: false });
    }
  }
  return safeJson(500, { ok: false });
}

function mediaMatchesPersistedSession(
  session: PersistedDownloadSession,
  media: DownloadSessionInitializeRequest['media'],
): boolean {
  return (
    media.contentType === session.contentType &&
    media.contentLength === session.contentLength &&
    media.strongEtag === session.strongEtag &&
    media.lastModified === session.lastModified &&
    media.rangeCapability === session.rangeCapability
  );
}

function sameSealedTarget(
  left: PersistedDownloadSession,
  right: PersistedDownloadSession,
): boolean {
  return (
    left.downloadId === right.downloadId &&
    left.sessionHash === right.sessionHash &&
    left.filename === right.filename &&
    left.shortcode === right.shortcode &&
    left.sealedMedia === right.sealedMedia &&
    left.contentType === right.contentType &&
    left.contentLength === right.contentLength &&
    left.strongEtag === right.strongEtag &&
    left.lastModified === right.lastModified &&
    left.rangeCapability === right.rangeCapability &&
    left.state.issuedAt === right.state.issuedAt &&
    left.state.absoluteExpiresAt === right.state.absoluteExpiresAt
  );
}

export class DownloadSession extends DurableObject<DownloadSessionEnv> {
  private readonly encryptionKey: string;
  private cleanupPending = false;
  private codecPromise: Promise<DownloadMediaCodec> | null = null;

  constructor(ctx: DurableObjectState, env: DownloadSessionEnv) {
    super(ctx, env);
    this.encryptionKey = env.DOWNLOAD_ENCRYPTION_KEY;
  }

  private createTables(): void {
    this.ctx.storage.sql.exec(sessionTableSql);
    this.ctx.storage.sql.exec(completedIntervalsTableSql);
    this.ctx.storage.sql.exec(activeLeasesTableSql);
  }

  private codec(): Promise<DownloadMediaCodec> {
    this.codecPromise ??= createDownloadMediaCodec(this.encryptionKey);
    return this.codecPromise;
  }

  private tableExists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
          name,
        )
        .toArray()[0] !== undefined
    );
  }

  private hasPersistedSession(): boolean {
    if (!this.tableExists('download_session')) {
      return false;
    }
    return (
      this.ctx.storage.sql
        .exec<{ singleton: number }>('SELECT singleton FROM download_session WHERE singleton = 1')
        .toArray()[0] !== undefined
    );
  }

  private restoreSessionFromStateTables(row: SessionRow): PersistedDownloadSession {
    const intervals = this.ctx.storage.sql
      .exec<IntervalRow>(
        `SELECT start_byte, end_byte, total_bytes
         FROM download_completed_intervals
         ORDER BY start_byte, end_byte, total_bytes`,
      )
      .toArray();
    const leases = this.ctx.storage.sql
      .exec<LeaseRow>(
        `SELECT holder_id, sequence, acquired_at, renewed_at, expires_at,
                requested_start, requested_end, requested_total
         FROM download_active_leases
         ORDER BY holder_id`,
      )
      .toArray();
    return restorePersistedSession(row, intervals, leases);
  }

  private readPersistedSession(): PersistedDownloadSession | null {
    if (!this.tableExists('download_session')) {
      return null;
    }
    const row = this.ctx.storage.sql
      .exec<SessionRow>(`SELECT ${SESSION_ROW_COLUMNS} FROM download_session WHERE singleton = 1`)
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    if (
      !this.tableExists('download_completed_intervals') ||
      !this.tableExists('download_active_leases')
    ) {
      return corruptStorage();
    }
    return this.restoreSessionFromStateTables(row);
  }

  private readPersistedSessionForRenewal(): PersistedDownloadSession | null {
    const tableRows = this.ctx.storage.sql
      .exec<{ readonly [key: string]: SqlValue; readonly name: SqlValue }>(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN (?, ?, ?)
         ORDER BY name`,
        'download_session',
        'download_completed_intervals',
        'download_active_leases',
      )
      .toArray();
    const tableNames = new Set<string>();
    for (const row of tableRows) {
      if (typeof row.name !== 'string' || tableNames.has(row.name)) {
        return corruptStorage();
      }
      tableNames.add(row.name);
    }
    if (!tableNames.has('download_session')) {
      return null;
    }
    if (
      !tableNames.has('download_completed_intervals') ||
      !tableNames.has('download_active_leases')
    ) {
      return corruptStorage();
    }
    const row = this.ctx.storage.sql
      .exec<SessionRow>(`SELECT ${SESSION_ROW_COLUMNS} FROM download_session WHERE singleton = 1`)
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    return this.restoreSessionFromStateTables(row);
  }

  private inspectLoadedSession(
    identity: DownloadSessionIdentityRequest,
    session: PersistedDownloadSession | null,
  ): Exclude<PersistedSessionInspectionResult, { readonly status: 500 }> {
    if (session === null) {
      return { status: 410 };
    }
    if (
      session.downloadId !== identity.downloadId ||
      session.sessionHash !== identity.sessionHash
    ) {
      return { status: 401 };
    }
    const inspection = inspectDownloadSession(session.state, Date.now());
    return inspection.available ? { status: 200, session, inspection } : { status: 410 };
  }

  private inspectPersistedSession(
    identity: DownloadSessionIdentityRequest,
  ): PersistedSessionInspectionResult {
    try {
      return this.inspectLoadedSession(identity, this.readPersistedSession());
    } catch {
      return { status: 500 };
    }
  }

  private inspectPersistedSessionForRenewal(
    identity: DownloadSessionIdentityRequest,
  ): PersistedSessionInspectionResult {
    try {
      return this.inspectLoadedSession(identity, this.readPersistedSessionForRenewal());
    } catch {
      return { status: 500 };
    }
  }

  private mediaBinding(session: PersistedDownloadSession): DownloadMediaBinding {
    return {
      sessionHash: session.sessionHash,
      downloadId: session.downloadId,
      filename: session.filename,
      shortcode: session.shortcode,
      issuedAt: session.state.issuedAt,
      absoluteExpiresAt: session.state.absoluteExpiresAt,
    };
  }

  private replaceState(state: DownloadSessionState): void {
    if (state.status === 'EXPIRED') {
      return corruptStorage();
    }
    this.ctx.storage.sql.exec(
      `UPDATE download_session SET
         status = ?, issued_at = ?, start_expires_at = ?, last_activity_at = ?,
         idle_expires_at = ?, absolute_expires_at = ?, completion_expires_at = ?,
         content_length = ?, validator_kind = ?, validator_value = ?
       WHERE singleton = 1`,
      state.status,
      state.issuedAt,
      state.startExpiresAt,
      state.lastActivityAt,
      state.idleExpiresAt,
      state.absoluteExpiresAt,
      state.completionExpiresAt,
      state.representation.total,
      state.representation.validator?.kind ?? null,
      state.representation.validator?.value ?? null,
    );
    this.ctx.storage.sql.exec('DELETE FROM download_completed_intervals');
    for (const interval of state.completedIntervals) {
      this.ctx.storage.sql.exec(
        `INSERT INTO download_completed_intervals (start_byte, end_byte, total_bytes)
         VALUES (?, ?, ?)`,
        interval.start,
        interval.end,
        interval.total,
      );
    }
    this.ctx.storage.sql.exec('DELETE FROM download_active_leases');
    for (const lease of state.leases) {
      this.ctx.storage.sql.exec(
        `INSERT INTO download_active_leases (
           holder_id, sequence, acquired_at, renewed_at, expires_at,
           requested_start, requested_end, requested_total
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        lease.holderId,
        lease.sequence,
        lease.acquiredAt,
        lease.renewedAt,
        lease.expiresAt,
        lease.requestedInterval?.start ?? null,
        lease.requestedInterval?.end ?? null,
        lease.requestedInterval?.total ?? null,
      );
    }
  }

  private renewalAlarmAt(state: DownloadSessionState, now: number): number {
    const alarmAt = this.ctx.storage.sql
      .exec<AlarmDeadlineRow>(
        `SELECT MIN(absolute_expires_at, idle_expires_at,
                    (SELECT MIN(expires_at) FROM download_active_leases)) AS alarm_at
         FROM download_session
         WHERE singleton = 1 AND status = 'ACTIVE'`,
      )
      .toArray()[0]?.alarm_at;
    if (
      alarmAt === undefined ||
      !isSafeInteger(alarmAt) ||
      alarmAt !== this.nextAlarmAt(state, now)
    ) {
      return corruptStorage();
    }
    return alarmAt;
  }

  private persistRenewal(
    previous: DownloadSessionState,
    renewed: RenewDownloadStreamResult,
    now: number,
    progress: boolean,
  ): number {
    const previousLease = previous.leases.find(
      (lease) => lease.holderId === renewed.lease.holderId,
    );
    if (previousLease === undefined) {
      return corruptStorage();
    }
    const previousInterval = previousLease.requestedInterval;
    const updated = this.ctx.storage.sql
      .exec<{ readonly [key: string]: SqlValue; readonly holder_id: SqlValue }>(
        `UPDATE download_active_leases
         SET sequence = ?, renewed_at = ?, expires_at = ?
         WHERE holder_id = ? AND sequence = ? AND acquired_at = ?
           AND renewed_at = ? AND expires_at = ?
           AND requested_start IS ? AND requested_end IS ? AND requested_total IS ?
         RETURNING holder_id`,
        renewed.lease.sequence,
        renewed.lease.renewedAt,
        renewed.lease.expiresAt,
        previousLease.holderId,
        previousLease.sequence,
        previousLease.acquiredAt,
        previousLease.renewedAt,
        previousLease.expiresAt,
        previousInterval?.start ?? null,
        previousInterval?.end ?? null,
        previousInterval?.total ?? null,
      )
      .toArray();
    if (updated.length !== 1 || updated[0]?.holder_id !== renewed.lease.holderId) {
      return corruptStorage();
    }

    const expiredHolderIds = previous.leases
      .filter((lease) => lease.expiresAt <= now)
      .map((lease) => lease.holderId)
      .sort();
    if (expiredHolderIds.length > 0) {
      const deletedHolderIds = this.ctx.storage.sql
        .exec<{ readonly [key: string]: SqlValue; readonly holder_id: SqlValue }>(
          `DELETE FROM download_active_leases
           WHERE expires_at <= ?
           RETURNING holder_id`,
          now,
        )
        .toArray()
        .map((row) => row.holder_id)
        .sort();
      if (
        deletedHolderIds.some((holderId) => typeof holderId !== 'string') ||
        deletedHolderIds.length !== expiredHolderIds.length ||
        deletedHolderIds.some((holderId, index) => holderId !== expiredHolderIds[index])
      ) {
        return corruptStorage();
      }
    }

    if (progress) {
      const updatedSession = this.ctx.storage.sql
        .exec<{ readonly [key: string]: SqlValue; readonly singleton: SqlValue }>(
          `UPDATE download_session
           SET last_activity_at = ?, idle_expires_at = ?
           WHERE singleton = 1 AND status = 'ACTIVE'
             AND last_activity_at IS ? AND idle_expires_at IS ?
           RETURNING singleton`,
          renewed.state.lastActivityAt,
          renewed.state.idleExpiresAt,
          previous.lastActivityAt,
          previous.idleExpiresAt,
        )
        .toArray();
      if (updatedSession.length !== 1 || updatedSession[0]?.singleton !== 1) {
        return corruptStorage();
      }
    }

    return this.renewalAlarmAt(renewed.state, now);
  }

  private nextAlarmAt(state: DownloadSessionState, now: number): number {
    const decision = decideDownloadAlarm(state, now);
    return decision.action === 'retain' ? decision.alarmAt : corruptStorage();
  }

  private persistInitialState(
    input: DownloadSessionInitializeRequest,
    sealedMedia: string,
    state: DownloadSessionState,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.createTables();
      if (this.hasPersistedSession()) {
        return false;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO download_session (
          singleton, schema_version, download_id, session_hash, filename, shortcode, sealed_media,
          content_type, content_length, strong_etag, last_modified, range_capability,
          validator_kind, validator_value, status, issued_at, start_expires_at, last_activity_at,
          idle_expires_at, absolute_expires_at, completion_expires_at
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.downloadId,
        input.sessionHash,
        input.filename,
        input.shortcode,
        sealedMedia,
        input.media.contentType,
        state.representation.total,
        input.media.strongEtag,
        input.media.lastModified,
        input.media.rangeCapability,
        state.representation.validator?.kind ?? null,
        state.representation.validator?.value ?? null,
        state.status,
        state.issuedAt,
        state.startExpiresAt,
        state.lastActivityAt,
        state.idleExpiresAt,
        state.absoluteExpiresAt,
        state.completionExpiresAt,
      );
      return true;
    });
  }

  private async deleteStorage(): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ctx.storage.deleteAll();
      } catch {
        this.cleanupPending = true;
        try {
          await this.ctx.storage.setAlarm(Date.now());
        } catch {
          // An immediate cleanup retry is best-effort while storage is unavailable.
        }
        return false;
      }

      this.cleanupPending = false;
      try {
        await this.ctx.storage.deleteAlarm();
      } catch {
        return false;
      }
      return true;
    });
  }

  private async resetAfterAlarmFailure(): Promise<void> {
    await this.deleteStorage();
  }

  private async scheduleMutationAlarm(alarmAt: number): Promise<boolean> {
    try {
      await this.ctx.storage.setAlarm(alarmAt);
      return true;
    } catch {
      await this.resetAfterAlarmFailure();
      return false;
    }
  }

  private async initialize(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeDownloadSessionInitializeRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }

    try {
      if (this.hasPersistedSession()) {
        return safeJson(409, { ok: false });
      }
    } catch {
      return safeJson(500, { ok: false });
    }

    const issuedAt = Date.now();
    let state: DownloadSessionState;
    try {
      state = issueDownloadSession({
        now: issuedAt,
        total: input.media.contentLength,
        validator: input.media.validator,
      });
    } catch {
      return safeJson(500, { ok: false });
    }
    const binding: DownloadMediaBinding = {
      sessionHash: input.sessionHash,
      downloadId: input.downloadId,
      filename: input.filename,
      shortcode: input.shortcode,
      issuedAt,
      absoluteExpiresAt: state.absoluteExpiresAt,
    };

    let sealedMedia: string;
    try {
      sealedMedia = await (await this.codec()).seal(input.media, binding, issuedAt);
    } catch {
      return safeJson(500, { ok: false });
    }

    let created: boolean;
    try {
      created = this.persistInitialState(input, sealedMedia, state);
    } catch {
      return safeJson(500, { ok: false });
    }
    if (!created) {
      return safeJson(409, { ok: false });
    }

    if (!(await this.scheduleMutationAlarm(state.startExpiresAt))) {
      return safeJson(500, { ok: false });
    }

    return safeJson(201, {
      ok: true,
      issuedAt: state.issuedAt,
      startExpiresAt: state.startExpiresAt,
      absoluteExpiresAt: state.absoluteExpiresAt,
    });
  }

  private inspectHead(request: Request): Response {
    if (request.body !== null) {
      return new Response(null, { status: 400 });
    }
    const identity = decodeDownloadSessionIdentityRequest({
      downloadId: request.headers.get('x-download-id'),
      sessionHash: request.headers.get('x-session-hash'),
    });
    if (identity === null) {
      return new Response(null, { status: 400 });
    }
    const result = this.inspectPersistedSession(identity);
    if (result.status !== 200) {
      return new Response(null, { status: result.status });
    }
    const headers = new Headers({
      'content-type': result.session.contentType,
      'x-download-filename': result.session.filename,
      'x-download-range-capability': result.session.rangeCapability,
    });
    if (result.session.contentLength !== null) {
      headers.set('content-length', String(result.session.contentLength));
    }
    if (result.session.strongEtag !== null) {
      headers.set('etag', result.session.strongEtag);
    }
    if (result.session.lastModified !== null) {
      headers.set('last-modified', result.session.lastModified);
    }
    return new Response(null, { status: 200, headers });
  }

  private async status(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const identity = decodeDownloadSessionIdentityRequest(body);
    if (identity === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.inspectPersistedSession(identity);
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    const { inspection, session } = result;
    return safeJson(200, {
      ok: true,
      filename: session.filename,
      contentType: session.contentType,
      contentLength: session.contentLength,
      strongEtag: session.strongEtag,
      lastModified: session.lastModified,
      rangeCapability: session.rangeCapability,
      status: inspection.status,
      available: inspection.available,
      startExpiresAt: inspection.startExpiresAt,
      idleExpiresAt: inspection.idleExpiresAt,
      absoluteExpiresAt: inspection.absoluteExpiresAt,
      completionExpiresAt: inspection.completionExpiresAt,
      activeStreams: inspection.activeStreams,
    });
  }

  private async acquire(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeDownloadSessionAcquireRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }

    const preflight = this.inspectPersistedSession(input);
    if (preflight.status !== 200) {
      return safeJson(preflight.status, { ok: false });
    }
    if (
      input.rangeHeader !== null &&
      decideIfRange(input.ifRangeHeader, preflight.session.state.representation.validator) ===
        'range' &&
      preflight.session.rangeCapability === 'none'
    ) {
      const total = preflight.session.state.representation.total;
      return rangeFailure(total === null ? undefined : `bytes */${String(total)}`);
    }
    let media: DownloadSessionInitializeRequest['media'];
    let mediaWire: ReturnType<typeof encodeProbedMediaWire>;
    try {
      media = await (
        await this.codec()
      ).open(preflight.session.sealedMedia, this.mediaBinding(preflight.session), Date.now());
      if (!mediaMatchesPersistedSession(preflight.session, media)) {
        return safeJson(500, { ok: false });
      }
      mediaWire = encodeProbedMediaWire(media);
    } catch {
      return safeJson(500, { ok: false });
    }

    let result:
      | Response
      | {
          readonly holderId: string;
          readonly sequence: number;
          readonly expiresAt: number;
          readonly request: ReturnType<typeof acquireDownloadStream>['request'];
          readonly alarmAt: number;
        };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const current = this.inspectPersistedSession(input);
        if (current.status !== 200) {
          return safeJson(current.status, { ok: false });
        }
        if (!sameSealedTarget(preflight.session, current.session)) {
          return safeJson(409, { ok: false });
        }
        const now = Date.now();
        const acquired = acquireDownloadStream(current.session.state, {
          now,
          holderId: createOpaqueId(192),
          rangeHeader: input.rangeHeader,
          ifRangeHeader: input.ifRangeHeader,
        });
        const alarmAt = this.nextAlarmAt(acquired.state, now);
        this.replaceState(acquired.state);
        return {
          holderId: acquired.lease.holderId,
          sequence: acquired.lease.sequence,
          expiresAt: acquired.lease.expiresAt,
          request: acquired.request,
          alarmAt,
        };
      });
    } catch (error: unknown) {
      return operationErrorResponse(error);
    }
    if (result instanceof Response) {
      return result;
    }
    if (!(await this.scheduleMutationAlarm(result.alarmAt))) {
      return safeJson(500, { ok: false });
    }
    return safeJson(201, {
      ok: true,
      holderId: result.holderId,
      sequence: result.sequence,
      expiresAt: result.expiresAt,
      request: result.request,
      media: mediaWire,
    });
  }

  private async renew(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeDownloadSessionRenewRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    let result:
      | Response
      | {
          readonly holderId: string;
          readonly sequence: number;
          readonly expiresAt: number;
          readonly alarmAt: number;
        };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const current = this.inspectPersistedSessionForRenewal(input);
        if (current.status !== 200) {
          return safeJson(current.status, { ok: false });
        }
        const now = Date.now();
        const renewed = renewDownloadStream(current.session.state, {
          now,
          holderId: input.holderId,
          sequence: input.sequence,
          progress: input.progress,
        });
        const alarmAt = this.persistRenewal(current.session.state, renewed, now, input.progress);
        return {
          holderId: renewed.lease.holderId,
          sequence: renewed.lease.sequence,
          expiresAt: renewed.lease.expiresAt,
          alarmAt,
        };
      });
    } catch (error: unknown) {
      return operationErrorResponse(error);
    }
    if (result instanceof Response) {
      return result;
    }
    if (!(await this.scheduleMutationAlarm(result.alarmAt))) {
      return safeJson(500, { ok: false });
    }
    return safeJson(200, {
      ok: true,
      holderId: result.holderId,
      sequence: result.sequence,
      expiresAt: result.expiresAt,
    });
  }

  private async finish(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeDownloadSessionFinishRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return this.finishDecoded(input);
  }

  private async finishDecoded(input: DownloadSessionFinishRequest): Promise<Response> {
    let result: Response | { readonly alarmAt: number };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const current = this.inspectPersistedSession(input);
        if (current.status !== 200) {
          return safeJson(current.status, { ok: false });
        }
        const now = Date.now();
        const state = finishDownloadStream(current.session.state, {
          now,
          holderId: input.holderId,
          sequence: input.sequence,
          normalEof: input.normalEof,
          actualBytes: input.actualBytes,
          upstream: {
            status: input.upstream.status,
            headers: downloadHeaderEvidenceSource(input.upstream.headers),
          },
        });
        const alarmAt = this.nextAlarmAt(state, now);
        this.replaceState(state);
        return { alarmAt };
      });
    } catch (error: unknown) {
      return operationErrorResponse(error);
    }
    if (result instanceof Response) {
      return result;
    }
    if (!(await this.scheduleMutationAlarm(result.alarmAt))) {
      return safeJson(500, { ok: false });
    }
    return safeJson(200, { ok: true });
  }

  private async interrupt(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeDownloadSessionInterruptRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return this.interruptDecoded(input);
  }

  private async interruptDecoded(input: DownloadSessionInterruptRequest): Promise<Response> {
    let result: Response | { readonly alarmAt: number };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const current = this.inspectPersistedSession(input);
        if (current.status !== 200) {
          return safeJson(current.status, { ok: false });
        }
        const now = Date.now();
        const state = interruptDownloadStream(current.session.state, {
          now,
          holderId: input.holderId,
          sequence: input.sequence,
        });
        const alarmAt = this.nextAlarmAt(state, now);
        this.replaceState(state);
        return { alarmAt };
      });
    } catch (error: unknown) {
      return operationErrorResponse(error);
    }
    if (result instanceof Response) {
      return result;
    }
    if (!(await this.scheduleMutationAlarm(result.alarmAt))) {
      return safeJson(500, { ok: false });
    }
    return safeJson(200, { ok: true });
  }

  private async destroy(request: Request): Promise<Response> {
    if (request.headers.get('content-type') !== 'application/json') {
      return safeJson(400, { ok: false });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const identity = decodeDownloadSessionIdentityRequest(body);
    if (identity === null) {
      return safeJson(400, { ok: false });
    }
    let session: PersistedDownloadSession | null;
    try {
      session = this.readPersistedSession();
      if (session !== null) {
        inspectDownloadSession(session.state, Date.now());
      }
    } catch {
      return safeJson(500, { ok: false });
    }
    if (session === null) {
      return safeJson(410, { ok: false });
    }
    if (
      session.downloadId !== identity.downloadId ||
      session.sessionHash !== identity.sessionHash
    ) {
      return safeJson(401, { ok: false });
    }
    return (await this.deleteStorage())
      ? safeJson(200, { ok: true })
      : safeJson(500, { ok: false });
  }

  private post(request: Request, pathname: string): Promise<Response> | Response {
    switch (pathname) {
      case '/status':
        return this.status(request);
      case '/initialize':
        return this.initialize(request);
      case '/acquire':
        return this.acquire(request);
      case '/renew':
        return this.renew(request);
      case '/finish':
        return this.finish(request);
      case '/interrupt':
        return this.interrupt(request);
      case '/destroy':
        return this.destroy(request);
      default:
        return safeJson(404, { ok: false });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.search !== '') {
      return request.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : safeJson(404, { ok: false });
    }
    if (request.method === 'HEAD') {
      return url.pathname === '/inspect'
        ? this.inspectHead(request)
        : new Response(null, { status: 404 });
    }
    return request.method === 'POST'
      ? this.post(request, url.pathname)
      : safeJson(404, { ok: false });
  }

  override async alarm(): Promise<void> {
    if (this.cleanupPending) {
      await this.deleteStorage();
      return;
    }
    let outcome:
      { readonly action: 'delete' } | { readonly action: 'retain'; readonly alarmAt: number };
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const session = this.readPersistedSession();
        if (session === null) {
          return { action: 'delete' } as const;
        }
        const now = Date.now();
        const decision = decideDownloadAlarm(session.state, now);
        if (decision.action === 'delete') {
          return { action: 'delete' } as const;
        }
        this.replaceState(decision.state);
        return { action: 'retain', alarmAt: decision.alarmAt } as const;
      });
    } catch {
      await this.deleteStorage();
      return;
    }
    if (outcome.action === 'delete') {
      await this.deleteStorage();
      return;
    }
    try {
      await this.ctx.storage.setAlarm(outcome.alarmAt);
    } catch {
      await this.deleteStorage();
    }
  }
}
