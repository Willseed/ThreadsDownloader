import { DurableObject } from 'cloudflare:workers';
import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import {
  createAesGcmSealer,
  createOpaqueId,
  importEncryptionKey,
} from './security/cryptography.js';
import {
  authorizeSessionRecord,
  createSessionRecord,
  isSessionRecord,
  resumeSessionRecord,
  sessionAlarmDecision,
  type AuthorizeSessionInput,
  type CreateSessionInput,
  type ResumeSessionInput,
  type SessionRecord,
} from './security/session-record.js';
import {
  acquireSessionDownloadPermit,
  isSessionDownloadId,
  isSessionDownloadPermitId,
  isSessionIdentityHash,
  nextSessionDownloadPermitDeadline,
  pruneSessionDownloadPermits,
  releaseSessionDownloadPermit,
  renewSessionDownloadPermit,
  SessionDownloadAdmissionStateError,
  SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS,
  type SessionDownloadAdmissionState,
  type SessionDownloadPermit,
} from './security/session-download-admission.js';
import {
  acquireResolvePermit,
  hydrateRateLimitState,
  nextResolvePermitDeadline,
  releaseResolvePermit,
  RESOLVE_WINDOW_MS,
  ResolveRateLimitError,
  type ResolveRateLimitState,
} from './security/rate-limit.js';
import {
  decodeResolveVaultClaimRequest,
  decodeResolveVaultSettleRequest,
  decodeResolveVaultStoreRequest,
  deriveResolvedMediaFilename,
  RESOLVE_VAULT_MAX_BATCHES,
  RESOLVE_VAULT_MAX_CANDIDATES,
  RESOLVE_VAULT_RESERVATION_MS,
  RESOLVE_VAULT_STAGING_MS,
  RESOLVE_VAULT_TTL_MS,
  type ResolveVaultClaimRequest,
  type ResolveVaultSettleRequest,
  type ResolveVaultStoreRequest,
  type SafeResolvedMediaCandidate,
} from './security/resolve-vault.js';
import { encodeProbedMediaWire } from './security/resolved-media-wire.js';
import {
  createResolvedMediaGrantCodec,
  type ResolvedMediaGrantBinding,
  type ResolvedMediaGrantCodec,
  ResolvedMediaGrantCodecError,
} from './security/resolved-media-grant.js';

const sessionTableSql = `CREATE TABLE IF NOT EXISTS session_record (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  session_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const resolveEventsTableSql = `CREATE TABLE IF NOT EXISTS resolve_events (
  event_at INTEGER NOT NULL
)`;
const resolvePermitsTableSql = `CREATE TABLE IF NOT EXISTS resolve_permits (
  permit_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
const sessionDownloadPermitsTableSql = `CREATE TABLE IF NOT EXISTS session_download_permits (
  permit_id TEXT PRIMARY KEY,
  download_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const sessionDownloadPermitsExpiryIndexSql = `CREATE INDEX IF NOT EXISTS session_download_permits_expiry
  ON session_download_permits (expires_at)`;
const resolveVaultBatchesTableSql = `CREATE TABLE IF NOT EXISTS resolved_media_batches (
  resolve_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  permit_id TEXT NOT NULL UNIQUE,
  shortcode TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging', 'ready')),
  store_token TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  staging_expires_at INTEGER,
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 10)
)`;
const resolveVaultCandidatesTableSql = `CREATE TABLE IF NOT EXISTS resolved_media_candidates (
  resolve_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  filename TEXT NOT NULL,
  content_length INTEGER,
  sealed_grant TEXT,
  reservation_id TEXT,
  reservation_expires_at INTEGER,
  PRIMARY KEY (resolve_id, candidate_id),
  UNIQUE (resolve_id, ordinal),
  CHECK ((reservation_id IS NULL) = (reservation_expires_at IS NULL))
)`;
const resolveVaultConsumptionsTableSql = `CREATE TABLE IF NOT EXISTS resolved_media_consumptions (
  resolve_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (resolve_id, candidate_id)
)`;
const resolveVaultExpiryIndexSql = `CREATE INDEX IF NOT EXISTS resolved_media_batches_expiry
  ON resolved_media_batches (expires_at)`;
const resolveVaultReservationIndexSql = `CREATE INDEX IF NOT EXISTS resolved_media_candidates_reservation
  ON resolved_media_candidates (reservation_expires_at)`;
const resolveVaultConsumptionExpiryIndexSql = `CREATE INDEX IF NOT EXISTS resolved_media_consumptions_expiry
  ON resolved_media_consumptions (expires_at)`;

interface AcquirePermitInput extends AuthorizeSessionInput {
  readonly now: number;
  readonly permitId: string;
}

interface ReleasePermitInput {
  readonly sessionHash: string;
  readonly permitId: string;
  readonly now: number;
}

export interface AcquireSessionDownloadPermitRequest {
  readonly sessionHash: string;
  readonly downloadId: string;
  readonly permitId: string;
}

export interface RenewSessionDownloadPermitRequest extends AcquireSessionDownloadPermitRequest {
  readonly sequence: number;
}

export type ReleaseSessionDownloadPermitRequest = AcquireSessionDownloadPermitRequest;

type SessionDownloadAdmissionHttpErrorStatus = 401 | 409 | 429 | 500;

export interface SessionCoordinatorEnv {
  readonly RESOLVED_MEDIA_GRANT_KEY: string;
}

interface PreparedVaultCandidate {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly filename: string;
  readonly contentLength: number | null;
  readonly media: ResolveVaultStoreRequest['candidates'][number];
}

type SqlValue = string | number | ArrayBuffer | null;

interface VaultCandidateRow {
  readonly [key: string]: SqlValue;
  readonly session_hash: string;
  readonly state: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly shortcode: string;
  readonly candidate_id: string;
  readonly ordinal: number;
  readonly filename: string;
  readonly content_length: number | null;
  readonly sealed_grant: string | null;
  readonly reservation_id: string | null;
  readonly reservation_expires_at: number | null;
}

interface AlarmDeadlineRow {
  readonly [key: string]: SqlValue;
  readonly download_deadline: SqlValue;
  readonly batch_deadline: SqlValue;
  readonly reservation_deadline: SqlValue;
  readonly consumption_deadline: SqlValue;
}

interface SessionDownloadPermitIdRow {
  readonly [key: string]: SqlValue;
  readonly permit_id: SqlValue;
}

export function decodeCreateSessionRequest(value: unknown): CreateSessionInput | null {
  const record = decodeExactRecord(value, ['csrfHash', 'expiresAt', 'issuedAt', 'sessionHash']);
  if (
    record === null ||
    typeof record['sessionHash'] !== 'string' ||
    typeof record['csrfHash'] !== 'string' ||
    typeof record['issuedAt'] !== 'number' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null;
  }
  return {
    sessionHash: record['sessionHash'],
    csrfHash: record['csrfHash'],
    issuedAt: record['issuedAt'],
    expiresAt: record['expiresAt'],
  };
}

export function decodeResumeSessionRequest(value: unknown): ResumeSessionInput | null {
  const record = decodeExactRecord(value, ['csrfHash', 'sessionHash']);
  if (
    record === null ||
    typeof record['sessionHash'] !== 'string' ||
    typeof record['csrfHash'] !== 'string'
  ) {
    return null;
  }
  return { sessionHash: record['sessionHash'], csrfHash: record['csrfHash'] };
}

export function decodeAuthorizeSessionRequest(
  value: unknown,
): (AuthorizeSessionInput & { readonly now: number }) | null {
  const record = decodeExactRecord(value, ['csrfHash', 'now', 'sessionHash']);
  if (
    record === null ||
    typeof record['sessionHash'] !== 'string' ||
    typeof record['csrfHash'] !== 'string' ||
    typeof record['now'] !== 'number'
  ) {
    return null;
  }
  return { sessionHash: record['sessionHash'], csrfHash: record['csrfHash'], now: record['now'] };
}

export function decodeAcquireResolvePermitRequest(value: unknown): AcquirePermitInput | null {
  const record = decodeExactRecord(value, ['csrfHash', 'now', 'permitId', 'sessionHash']);
  if (
    record === null ||
    typeof record['sessionHash'] !== 'string' ||
    typeof record['csrfHash'] !== 'string' ||
    typeof record['permitId'] !== 'string' ||
    typeof record['now'] !== 'number'
  ) {
    return null;
  }
  return {
    sessionHash: record['sessionHash'],
    csrfHash: record['csrfHash'],
    permitId: record['permitId'],
    now: record['now'],
  };
}

export function decodeReleaseResolvePermitRequest(value: unknown): ReleasePermitInput | null {
  const record = decodeExactRecord(value, ['now', 'permitId', 'sessionHash']);
  if (
    record === null ||
    typeof record['sessionHash'] !== 'string' ||
    typeof record['permitId'] !== 'string' ||
    typeof record['now'] !== 'number'
  ) {
    return null;
  }
  return { sessionHash: record['sessionHash'], permitId: record['permitId'], now: record['now'] };
}

export function decodeAcquireSessionDownloadPermitRequest(
  value: unknown,
): AcquireSessionDownloadPermitRequest | null {
  const record = decodeExactRecord(value, ['downloadId', 'permitId', 'sessionHash']);
  if (
    record === null ||
    !isSessionIdentityHash(record['sessionHash']) ||
    !isSessionDownloadId(record['downloadId']) ||
    !isSessionDownloadPermitId(record['permitId'])
  ) {
    return null;
  }
  return {
    sessionHash: record['sessionHash'],
    downloadId: record['downloadId'],
    permitId: record['permitId'],
  };
}

export function decodeRenewSessionDownloadPermitRequest(
  value: unknown,
): RenewSessionDownloadPermitRequest | null {
  const record = decodeExactRecord(value, ['downloadId', 'permitId', 'sequence', 'sessionHash']);
  if (
    record === null ||
    !isSessionIdentityHash(record['sessionHash']) ||
    !isSessionDownloadId(record['downloadId']) ||
    !isSessionDownloadPermitId(record['permitId']) ||
    !Number.isSafeInteger(record['sequence']) ||
    (record['sequence'] as number) < 0
  ) {
    return null;
  }
  return {
    sessionHash: record['sessionHash'],
    downloadId: record['downloadId'],
    permitId: record['permitId'],
    sequence: record['sequence'] as number,
  };
}

export const decodeReleaseSessionDownloadPermitRequest = decodeAcquireSessionDownloadPermitRequest;

function safeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function sessionDownloadAdmissionErrorStatus(
  error: SessionDownloadAdmissionStateError,
): 409 | 429 | 500 {
  if (error.code === 'SESSION_DOWNLOAD_LIMIT') {
    return 429;
  }
  if (error.code === 'SESSION_DOWNLOAD_CONFLICT' || error.code === 'SESSION_DOWNLOAD_EXPIRED') {
    return 409;
  }
  return 500;
}

export class SessionCoordinator extends DurableObject<SessionCoordinatorEnv> {
  private readonly grantKey: string;
  private grantCodecPromise: Promise<ResolvedMediaGrantCodec> | null = null;

  constructor(ctx: DurableObjectState, env: SessionCoordinatorEnv) {
    super(ctx, env);
    this.grantKey = env.RESOLVED_MEDIA_GRANT_KEY;
    this.initializeTables();
  }

  private initializeTables(): void {
    this.ctx.storage.sql.exec(sessionTableSql);
    this.ctx.storage.sql.exec(resolveEventsTableSql);
    this.ctx.storage.sql.exec(resolvePermitsTableSql);
    this.ctx.storage.sql.exec(sessionDownloadPermitsTableSql);
    this.ctx.storage.sql.exec(sessionDownloadPermitsExpiryIndexSql);
    this.ctx.storage.sql.exec(resolveVaultBatchesTableSql);
    this.ctx.storage.sql.exec(resolveVaultCandidatesTableSql);
    this.ctx.storage.sql.exec(resolveVaultConsumptionsTableSql);
    this.ctx.storage.sql.exec(resolveVaultExpiryIndexSql);
    this.ctx.storage.sql.exec(resolveVaultReservationIndexSql);
    this.ctx.storage.sql.exec(resolveVaultConsumptionExpiryIndexSql);
  }

  private grantCodec(): Promise<ResolvedMediaGrantCodec> {
    this.grantCodecPromise ??= importEncryptionKey(this.grantKey).then((key) =>
      createResolvedMediaGrantCodec(createAesGcmSealer(key)),
    );
    return this.grantCodecPromise;
  }

  private readRecord(): SessionRecord | null {
    const row = this.ctx.storage.sql
      .exec(
        'SELECT schema_version, session_hash, csrf_hash, issued_at, expires_at FROM session_record WHERE singleton = 1',
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    const candidate: unknown = {
      schemaVersion: row['schema_version'],
      sessionHash: row['session_hash'],
      csrfHash: row['csrf_hash'],
      issuedAt: row['issued_at'],
      expiresAt: row['expires_at'],
    };
    if (!isSessionRecord(candidate)) {
      throw new Error('Stored session record is invalid.');
    }
    return candidate;
  }

  private writeRecord(record: SessionRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO session_record
        (singleton, schema_version, session_hash, csrf_hash, issued_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        session_hash = excluded.session_hash,
        csrf_hash = excluded.csrf_hash,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at`,
      record.schemaVersion,
      record.sessionHash,
      record.csrfHash,
      record.issuedAt,
      record.expiresAt,
    );
  }

  private pruneResolveStorage(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM resolve_events WHERE event_at <= ?',
      now - RESOLVE_WINDOW_MS,
    );
    this.ctx.storage.sql.exec('DELETE FROM resolve_permits WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM resolved_media_consumptions WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec(
      `UPDATE resolved_media_candidates
       SET reservation_id = NULL, reservation_expires_at = NULL
       WHERE reservation_expires_at <= ?`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM resolved_media_candidates
       WHERE resolve_id IN (
         SELECT resolve_id FROM resolved_media_batches
         WHERE expires_at <= ?
            OR (state = 'staging' AND staging_expires_at <= ?)
       )`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM resolved_media_batches
       WHERE expires_at <= ?
          OR (state = 'staging' AND staging_expires_at <= ?)`,
      now,
      now,
    );
  }

  private readResolveState(): ResolveRateLimitState {
    const eventRows = this.ctx.storage.sql
      .exec<{ event_at: number }>('SELECT event_at FROM resolve_events ORDER BY event_at')
      .toArray();
    const permitRows = this.ctx.storage.sql
      .exec<{ permit_id: string; expires_at: number }>(
        'SELECT permit_id, expires_at FROM resolve_permits ORDER BY expires_at',
      )
      .toArray();
    return hydrateRateLimitState(eventRows, permitRows);
  }

  private readSessionDownloadState(): SessionDownloadAdmissionState {
    const permits = this.ctx.storage.sql
      .exec<{
        permit_id: string;
        download_id: string;
        sequence: number;
        acquired_at: number;
        renewed_at: number;
        expires_at: number;
      }>(
        `SELECT permit_id, download_id, sequence, acquired_at, renewed_at, expires_at
         FROM session_download_permits ORDER BY expires_at, permit_id`,
      )
      .toArray()
      .map((row): SessionDownloadPermit => ({
        permitId: row['permit_id'],
        downloadId: row['download_id'],
        sequence: row['sequence'],
        acquiredAt: row['acquired_at'],
        renewedAt: row['renewed_at'],
        expiresAt: row['expires_at'],
      }));
    return { permits };
  }

  private writeSessionDownloadState(state: SessionDownloadAdmissionState): void {
    this.ctx.storage.sql.exec('DELETE FROM session_download_permits');
    for (const permit of state.permits) {
      this.ctx.storage.sql.exec(
        `INSERT INTO session_download_permits
          (permit_id, download_id, sequence, acquired_at, renewed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        permit.permitId,
        permit.downloadId,
        permit.sequence,
        permit.acquiredAt,
        permit.renewedAt,
        permit.expiresAt,
      );
    }
  }

  private compareAndSwapSessionDownloadPermit(
    expected: SessionDownloadPermit,
    replacement: SessionDownloadPermit,
  ): void {
    if (
      replacement.permitId !== expected.permitId ||
      replacement.downloadId !== expected.downloadId ||
      replacement.acquiredAt !== expected.acquiredAt
    ) {
      throw new Error('Session download permit binding changed unexpectedly.');
    }
    const updated = this.ctx.storage.sql.exec<SessionDownloadPermitIdRow>(
      `UPDATE session_download_permits
       SET sequence = ?, renewed_at = ?, expires_at = ?
       WHERE permit_id = ? AND download_id = ? AND sequence = ? AND acquired_at = ?
         AND renewed_at = ? AND expires_at = ?
       RETURNING permit_id`,
      replacement.sequence,
      replacement.renewedAt,
      replacement.expiresAt,
      expected.permitId,
      expected.downloadId,
      expected.sequence,
      expected.acquiredAt,
      expected.renewedAt,
      expected.expiresAt,
    );
    if (updated.one().permit_id !== replacement.permitId) {
      throw new Error('Stored session download permit changed unexpectedly.');
    }
  }

  private deleteExpiredSessionDownloadPermits(
    current: SessionDownloadAdmissionState,
    next: SessionDownloadAdmissionState,
    now: number,
  ): void {
    const expiredPermitIds = current.permits
      .filter((permit) => permit.expiresAt <= now)
      .map((permit) => permit.permitId)
      .sort((left, right) => left.localeCompare(right));
    if (expiredPermitIds.length === 0) {
      return;
    }
    const deletedPermitIds = this.ctx.storage.sql
      .exec<SessionDownloadPermitIdRow>(
        `DELETE FROM session_download_permits
         WHERE expires_at <= ?
         RETURNING permit_id`,
        now,
      )
      .toArray()
      .map((row) => row.permit_id)
      .sort((left, right) => String(left).localeCompare(String(right)));
    if (
      current.permits.length - next.permits.length !== expiredPermitIds.length ||
      deletedPermitIds.some((permitId) => typeof permitId !== 'string') ||
      deletedPermitIds.length !== expiredPermitIds.length ||
      deletedPermitIds.some((permitId, index) => permitId !== expiredPermitIds[index])
    ) {
      throw new Error('Stored expired session download permits changed unexpectedly.');
    }
  }

  private pruneSessionDownloadStorage(now: number): SessionDownloadAdmissionState {
    const current = this.readSessionDownloadState();
    const next = pruneSessionDownloadPermits(current, now);
    this.deleteExpiredSessionDownloadPermits(current, next, now);
    return next;
  }

  private readAlarmDeadlines(expectedDownloadDeadline: number | null): readonly number[] {
    const row = this.ctx.storage.sql
      .exec<AlarmDeadlineRow>(
        `SELECT
           (SELECT MIN(expires_at) FROM session_download_permits) AS download_deadline,
           (SELECT MIN(
              CASE
                WHEN state = 'staging' AND staging_expires_at < expires_at
                  THEN staging_expires_at
                ELSE expires_at
              END
            ) FROM resolved_media_batches) AS batch_deadline,
           (SELECT MIN(reservation_expires_at)
            FROM resolved_media_candidates) AS reservation_deadline,
           (SELECT MIN(expires_at)
            FROM resolved_media_consumptions) AS consumption_deadline`,
      )
      .one();
    if (row.download_deadline !== expectedDownloadDeadline) {
      throw new Error('Stored session download permit deadline is invalid.');
    }
    return [row.batch_deadline, row.reservation_deadline, row.consumption_deadline].filter(
      (value): value is number => typeof value === 'number',
    );
  }

  private async scheduleAlarm(
    record: SessionRecord,
    validatedDownloadState?: SessionDownloadAdmissionState,
  ): Promise<void> {
    const permitDeadline = nextResolvePermitDeadline(this.readResolveState());
    const downloadPermitDeadline = nextSessionDownloadPermitDeadline(
      validatedDownloadState ?? this.readSessionDownloadState(),
    );
    const deadlines = [
      record.expiresAt,
      permitDeadline,
      downloadPermitDeadline,
      ...this.readAlarmDeadlines(downloadPermitDeadline),
    ].filter((value): value is number => value !== null);
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private deleteCandidateAndEmptyBatch(resolveId: string, candidateId: string): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM resolved_media_candidates WHERE resolve_id = ? AND candidate_id = ?',
      resolveId,
      candidateId,
    );
    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM resolved_media_candidates WHERE resolve_id = ?',
        resolveId,
      )
      .toArray()[0]?.['count'];
    if (remaining === 0) {
      this.ctx.storage.sql.exec(
        'DELETE FROM resolved_media_batches WHERE resolve_id = ?',
        resolveId,
      );
    }
  }

  private compensateStaging(resolveId: string, storeToken: string): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ resolve_id: string }>(
          `SELECT resolve_id FROM resolved_media_batches
           WHERE resolve_id = ? AND state = 'staging' AND store_token = ?`,
          resolveId,
          storeToken,
        )
        .toArray()[0];
      if (row === undefined) {
        return;
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM resolved_media_candidates WHERE resolve_id = ?',
        resolveId,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM resolved_media_batches
         WHERE resolve_id = ? AND state = 'staging' AND store_token = ?`,
        resolveId,
        storeToken,
      );
    });
  }

  private grantBinding(
    input: {
      readonly sessionHash: string;
      readonly resolveId: string;
      readonly shortcode: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
    },
    candidate: Pick<
      PreparedVaultCandidate,
      'candidateId' | 'contentLength' | 'filename' | 'ordinal'
    >,
  ): ResolvedMediaGrantBinding {
    return {
      sessionHash: input.sessionHash,
      resolveId: input.resolveId,
      candidateId: candidate.candidateId,
      ordinal: candidate.ordinal,
      filename: candidate.filename,
      shortcode: input.shortcode,
      contentLength: candidate.contentLength,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
  }

  private prepareVaultCandidates(input: ResolveVaultStoreRequest): PreparedVaultCandidate[] {
    return input.candidates.map((media, index) => ({
      candidateId: createOpaqueId(192),
      ordinal: index + 1,
      filename: deriveResolvedMediaFilename(input.shortcode, index + 1, media.contentType),
      contentLength: media.contentLength,
      media,
    }));
  }

  private reserveVaultStore(
    input: ResolveVaultStoreRequest,
    resolveId: string,
    storeToken: string,
    candidates: readonly PreparedVaultCandidate[],
    admittedAt: number,
  ):
    | {
        readonly status: 201;
        readonly record: SessionRecord;
        readonly issuedAt: number;
        readonly expiresAt: number;
      }
    | { readonly status: 400 | 401 | 409 | 429 } {
    return this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, admittedAt) || record === null) {
        return { status: 401 } as const;
      }
      if (admittedAt > Number.MAX_SAFE_INTEGER - RESOLVE_VAULT_TTL_MS) {
        return { status: 400 } as const;
      }
      this.pruneResolveStorage(admittedAt);
      const permit = this.ctx.storage.sql
        .exec<{ permit_id: string }>(
          'SELECT permit_id FROM resolve_permits WHERE permit_id = ? AND expires_at > ?',
          input.permitId,
          admittedAt,
        )
        .toArray()[0];
      if (permit === undefined) {
        return { status: 409 } as const;
      }
      const permitUse = this.ctx.storage.sql
        .exec<{ resolve_id: string }>(
          'SELECT resolve_id FROM resolved_media_batches WHERE permit_id = ?',
          input.permitId,
        )
        .toArray()[0];
      if (permitUse !== undefined) {
        return { status: 409 } as const;
      }
      const capacity = this.ctx.storage.sql
        .exec<{ batch_count: number; candidate_count: number }>(
          `SELECT COUNT(*) AS batch_count,
                  COALESCE(SUM(candidate_count), 0) AS candidate_count
           FROM resolved_media_batches`,
        )
        .toArray()[0];
      if (
        capacity === undefined ||
        capacity['batch_count'] >= RESOLVE_VAULT_MAX_BATCHES ||
        capacity['candidate_count'] + candidates.length > RESOLVE_VAULT_MAX_CANDIDATES
      ) {
        return { status: 429 } as const;
      }

      const expiresAt = Math.min(record.expiresAt, admittedAt + RESOLVE_VAULT_TTL_MS);
      if (expiresAt <= admittedAt) {
        return { status: 401 } as const;
      }
      const stagingExpiresAt = Math.min(expiresAt, admittedAt + RESOLVE_VAULT_STAGING_MS);
      this.ctx.storage.sql.exec(
        `INSERT INTO resolved_media_batches
          (resolve_id, session_hash, permit_id, shortcode, state, store_token, issued_at, expires_at,
           staging_expires_at, candidate_count)
         VALUES (?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?)`,
        resolveId,
        input.sessionHash,
        input.permitId,
        input.shortcode,
        storeToken,
        admittedAt,
        expiresAt,
        stagingExpiresAt,
        candidates.length,
      );
      for (const candidate of candidates) {
        this.ctx.storage.sql.exec(
          `INSERT INTO resolved_media_candidates
            (resolve_id, candidate_id, ordinal, filename, content_length, sealed_grant,
             reservation_id, reservation_expires_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          resolveId,
          candidate.candidateId,
          candidate.ordinal,
          candidate.filename,
          candidate.contentLength,
        );
      }
      return { status: 201, record, issuedAt: admittedAt, expiresAt } as const;
    });
  }

  private commitVaultStore(
    input: ResolveVaultStoreRequest,
    resolveId: string,
    storeToken: string,
    candidates: readonly PreparedVaultCandidate[],
    sealedGrants: readonly string[],
    committedAt: number,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, committedAt)) {
        return false;
      }
      const permit = this.ctx.storage.sql
        .exec<{ permit_id: string }>(
          'SELECT permit_id FROM resolve_permits WHERE permit_id = ? AND expires_at > ?',
          input.permitId,
          committedAt,
        )
        .toArray()[0];
      if (permit === undefined) {
        return false;
      }
      const batch = this.ctx.storage.sql
        .exec<{ candidate_count: number }>(
          `SELECT candidate_count FROM resolved_media_batches
           WHERE resolve_id = ? AND session_hash = ? AND permit_id = ? AND state = 'staging'
             AND store_token = ? AND issued_at <= ? AND staging_expires_at > ?
             AND expires_at > ? AND expires_at - issued_at <= ?`,
          resolveId,
          input.sessionHash,
          input.permitId,
          storeToken,
          committedAt,
          committedAt,
          committedAt,
          RESOLVE_VAULT_TTL_MS,
        )
        .toArray()[0];
      const storedCandidates = this.ctx.storage.sql
        .exec<{ candidate_id: string }>(
          `SELECT candidate_id FROM resolved_media_candidates
           WHERE resolve_id = ? AND sealed_grant IS NULL ORDER BY ordinal`,
          resolveId,
        )
        .toArray();
      if (
        batch?.['candidate_count'] !== candidates.length ||
        sealedGrants.length !== candidates.length ||
        storedCandidates.length !== candidates.length ||
        storedCandidates.some(
          (row, index) => row['candidate_id'] !== candidates[index]?.candidateId,
        )
      ) {
        return false;
      }
      for (let index = 0; index < candidates.length; index += 1) {
        this.ctx.storage.sql.exec(
          `UPDATE resolved_media_candidates SET sealed_grant = ?
           WHERE resolve_id = ? AND candidate_id = ? AND sealed_grant IS NULL`,
          sealedGrants[index]!,
          resolveId,
          candidates[index]!.candidateId,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE resolved_media_batches
         SET state = 'ready', store_token = NULL, staging_expires_at = NULL
         WHERE resolve_id = ? AND session_hash = ? AND permit_id = ? AND state = 'staging'
           AND store_token = ? AND issued_at <= ? AND staging_expires_at > ?
           AND expires_at > ? AND expires_at - issued_at <= ?`,
        resolveId,
        input.sessionHash,
        input.permitId,
        storeToken,
        committedAt,
        committedAt,
        committedAt,
        RESOLVE_VAULT_TTL_MS,
      );
      return true;
    });
  }

  private safeVaultCandidates(
    candidates: readonly PreparedVaultCandidate[],
  ): SafeResolvedMediaCandidate[] {
    return candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      filename: candidate.filename,
      ...(candidate.contentLength === null ? {} : { contentLength: candidate.contentLength }),
    }));
  }

  private async storeVault(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeResolveVaultStoreRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }

    let resolveId: string;
    let storeToken: string;
    let candidates: PreparedVaultCandidate[];
    try {
      resolveId = createOpaqueId(192);
      storeToken = createOpaqueId(192);
      candidates = this.prepareVaultCandidates(input);
    } catch {
      return safeJson(500, { ok: false });
    }

    let reservation: ReturnType<SessionCoordinator['reserveVaultStore']>;
    try {
      reservation = this.reserveVaultStore(input, resolveId, storeToken, candidates, Date.now());
    } catch {
      return safeJson(500, { ok: false });
    }
    if (reservation.status !== 201) {
      return safeJson(reservation.status, { ok: false });
    }

    try {
      await this.scheduleAlarm(reservation.record);
      const codec = await this.grantCodec();
      const batchBinding = {
        sessionHash: input.sessionHash,
        resolveId,
        shortcode: input.shortcode,
        issuedAt: reservation.issuedAt,
        expiresAt: reservation.expiresAt,
      };
      const sealedGrants = await Promise.all(
        candidates.map((candidate) =>
          codec.seal(
            candidate.media,
            this.grantBinding(batchBinding, candidate),
            reservation.issuedAt,
          ),
        ),
      );
      if (
        !this.commitVaultStore(input, resolveId, storeToken, candidates, sealedGrants, Date.now())
      ) {
        this.compensateStaging(resolveId, storeToken);
        return safeJson(500, { ok: false });
      }
    } catch {
      this.compensateStaging(resolveId, storeToken);
      return safeJson(500, { ok: false });
    }

    return safeJson(201, {
      ok: true,
      resolveId,
      issuedAt: reservation.issuedAt,
      expiresAt: reservation.expiresAt,
      candidates: this.safeVaultCandidates(candidates),
    });
  }

  private readVaultCandidate(
    resolveId: string,
    candidateId: string,
  ): VaultCandidateRow | undefined {
    return this.ctx.storage.sql
      .exec<VaultCandidateRow>(
        `SELECT b.session_hash, b.state, b.issued_at, b.expires_at, b.shortcode,
                c.candidate_id, c.ordinal, c.filename, c.content_length,
                c.sealed_grant, c.reservation_id, c.reservation_expires_at
         FROM resolved_media_batches b
         INNER JOIN resolved_media_candidates c ON c.resolve_id = b.resolve_id
         WHERE b.resolve_id = ? AND c.candidate_id = ?`,
        resolveId,
        candidateId,
      )
      .toArray()[0];
  }

  private reserveVaultClaim(
    input: ResolveVaultClaimRequest,
    reservedAt: number,
  ):
    | {
        readonly status: 200;
        readonly record: SessionRecord;
        readonly row: VaultCandidateRow;
        readonly reservedAt: number;
        readonly reservationExpiresAt: number;
      }
    | { readonly status: 400 | 401 | 404 | 409 | 500 } {
    return this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, reservedAt) || record === null) {
        return { status: 401 } as const;
      }
      if (reservedAt > Number.MAX_SAFE_INTEGER - RESOLVE_VAULT_RESERVATION_MS) {
        return { status: 400 } as const;
      }
      this.pruneResolveStorage(reservedAt);
      const row = this.readVaultCandidate(input.resolveId, input.candidateId);
      if (row?.['state'] !== 'ready') {
        return { status: 404 } as const;
      }
      if (row['session_hash'] !== input.sessionHash) {
        return { status: 401 } as const;
      }
      if (row['sealed_grant'] === null) {
        this.deleteCandidateAndEmptyBatch(input.resolveId, input.candidateId);
        return { status: 500 } as const;
      }
      if (row['reservation_id'] !== null && row['reservation_id'] !== input.reservationId) {
        return { status: 409 } as const;
      }
      let reservationExpiresAt = row['reservation_expires_at'];
      if (row['reservation_id'] === null || reservationExpiresAt === null) {
        reservationExpiresAt = Math.min(
          row['expires_at'],
          reservedAt + RESOLVE_VAULT_RESERVATION_MS,
        );
        this.ctx.storage.sql.exec(
          `UPDATE resolved_media_candidates
           SET reservation_id = ?, reservation_expires_at = ?
           WHERE resolve_id = ? AND candidate_id = ? AND reservation_id IS NULL`,
          input.reservationId,
          reservationExpiresAt,
          input.resolveId,
          input.candidateId,
        );
      }
      return {
        status: 200,
        record,
        row: {
          ...row,
          reservation_id: input.reservationId,
          reservation_expires_at: reservationExpiresAt,
        },
        reservedAt,
        reservationExpiresAt,
      } as const;
    });
  }

  private releaseVaultReservation(input: ResolveVaultClaimRequest): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE resolved_media_candidates
         SET reservation_id = NULL, reservation_expires_at = NULL
         WHERE resolve_id = ? AND candidate_id = ? AND reservation_id = ?`,
        input.resolveId,
        input.candidateId,
        input.reservationId,
      );
    });
  }

  private tryReleaseVaultReservation(input: ResolveVaultClaimRequest): void {
    try {
      this.releaseVaultReservation(input);
    } catch {
      // A fixed 500 response is safer than exposing a transient storage detail.
    }
  }

  private deleteCorruptVaultClaim(input: ResolveVaultClaimRequest): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ candidate_id: string }>(
          `SELECT candidate_id FROM resolved_media_candidates
           WHERE resolve_id = ? AND candidate_id = ? AND reservation_id = ?`,
          input.resolveId,
          input.candidateId,
          input.reservationId,
        )
        .toArray()[0];
      if (row !== undefined) {
        this.deleteCandidateAndEmptyBatch(input.resolveId, input.candidateId);
      }
    });
  }

  private tryDeleteCorruptVaultClaim(input: ResolveVaultClaimRequest): void {
    try {
      this.deleteCorruptVaultClaim(input);
    } catch {
      // The exact reservation predicate prevents deleting a replacement claim.
    }
  }

  private bindingFromRow(
    input: ResolveVaultClaimRequest,
    row: VaultCandidateRow,
  ): ResolvedMediaGrantBinding {
    return {
      sessionHash: input.sessionHash,
      resolveId: input.resolveId,
      candidateId: input.candidateId,
      ordinal: row['ordinal'],
      filename: row['filename'],
      shortcode: row['shortcode'],
      contentLength: row['content_length'],
      issuedAt: row['issued_at'],
      expiresAt: row['expires_at'],
    };
  }

  private confirmVaultClaim(
    input: ResolveVaultClaimRequest,
    expected: VaultCandidateRow,
    confirmedAt: number,
  ): 200 | 401 | 404 | 409 | 500 {
    return this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, confirmedAt)) {
        return 401;
      }
      this.pruneResolveStorage(confirmedAt);
      const current = this.readVaultCandidate(input.resolveId, input.candidateId);
      if (current?.['state'] !== 'ready') {
        return 404;
      }
      if (current['session_hash'] !== input.sessionHash) {
        return 401;
      }
      if (
        current['reservation_id'] !== input.reservationId ||
        current['reservation_expires_at'] === null ||
        current['reservation_expires_at'] <= confirmedAt ||
        current['reservation_expires_at'] > confirmedAt + RESOLVE_VAULT_RESERVATION_MS
      ) {
        return 409;
      }
      if (
        current['issued_at'] > confirmedAt ||
        current['expires_at'] <= confirmedAt ||
        current['expires_at'] - current['issued_at'] > RESOLVE_VAULT_TTL_MS ||
        current['issued_at'] !== expected['issued_at'] ||
        current['expires_at'] !== expected['expires_at'] ||
        current['candidate_id'] !== expected['candidate_id'] ||
        current['ordinal'] !== expected['ordinal'] ||
        current['filename'] !== expected['filename'] ||
        current['shortcode'] !== expected['shortcode'] ||
        current['content_length'] !== expected['content_length'] ||
        current['sealed_grant'] !== expected['sealed_grant'] ||
        current['reservation_expires_at'] !== expected['reservation_expires_at']
      ) {
        this.deleteCandidateAndEmptyBatch(input.resolveId, input.candidateId);
        return 500;
      }
      return 200;
    });
  }

  private vaultClaimResponse(
    input: ResolveVaultClaimRequest,
    reservedAt: number,
    reservationExpiresAt: number,
    filename: string,
    shortcode: string,
    media: PreparedVaultCandidate['media'],
  ): Response {
    try {
      return safeJson(200, {
        ok: true,
        reservationId: input.reservationId,
        reservedAt,
        reservationExpiresAt,
        filename,
        shortcode,
        grant: encodeProbedMediaWire(media),
      });
    } catch {
      this.tryReleaseVaultReservation(input);
      return safeJson(500, { ok: false });
    }
  }

  private async claimVault(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeResolveVaultClaimRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }

    let claim: ReturnType<SessionCoordinator['reserveVaultClaim']>;
    try {
      claim = this.reserveVaultClaim(input, Date.now());
    } catch {
      return safeJson(500, { ok: false });
    }
    if (claim.status !== 200) {
      return safeJson(claim.status, { ok: false });
    }

    try {
      await this.scheduleAlarm(claim.record);
    } catch {
      this.tryReleaseVaultReservation(input);
      return safeJson(500, { ok: false });
    }
    let codec: ResolvedMediaGrantCodec;
    try {
      codec = await this.grantCodec();
    } catch {
      this.tryReleaseVaultReservation(input);
      return safeJson(500, { ok: false });
    }
    const openingAt = Date.now();
    let confirmation: ReturnType<SessionCoordinator['confirmVaultClaim']>;
    try {
      confirmation = this.confirmVaultClaim(input, claim.row, openingAt);
    } catch {
      this.tryReleaseVaultReservation(input);
      return safeJson(500, { ok: false });
    }
    if (confirmation !== 200) {
      this.tryReleaseVaultReservation(input);
      return safeJson(confirmation, { ok: false });
    }

    let media: Awaited<ReturnType<ResolvedMediaGrantCodec['open']>>;
    try {
      media = await codec.open(
        claim.row['sealed_grant']!,
        this.bindingFromRow(input, claim.row),
        openingAt,
      );
    } catch (error: unknown) {
      if (
        error instanceof ResolvedMediaGrantCodecError &&
        error.code === 'RESOLVED_MEDIA_GRANT_INVALID'
      ) {
        this.tryDeleteCorruptVaultClaim(input);
      } else {
        this.tryReleaseVaultReservation(input);
      }
      return safeJson(500, { ok: false });
    }

    try {
      confirmation = this.confirmVaultClaim(input, claim.row, Date.now());
    } catch {
      this.tryReleaseVaultReservation(input);
      return safeJson(500, { ok: false });
    }
    if (confirmation !== 200) {
      this.tryReleaseVaultReservation(input);
      return safeJson(confirmation, { ok: false });
    }
    return this.vaultClaimResponse(
      input,
      claim.reservedAt,
      claim.reservationExpiresAt,
      claim.row['filename'],
      claim.row['shortcode'],
      media,
    );
  }

  private settleMissingVaultCandidate(
    input: ResolveVaultSettleRequest,
    settledAt: number,
    record: SessionRecord,
  ): { readonly status: 200; readonly record: SessionRecord } | { readonly status: 401 | 409 } {
    const consumed = this.ctx.storage.sql
      .exec<{ session_hash: string; reservation_id: string }>(
        `SELECT session_hash, reservation_id FROM resolved_media_consumptions
         WHERE resolve_id = ? AND candidate_id = ? AND expires_at > ?`,
        input.resolveId,
        input.candidateId,
        settledAt,
      )
      .toArray()[0];
    if (consumed === undefined) {
      return { status: 409 };
    }
    if (consumed['session_hash'] !== input.sessionHash) {
      return { status: 401 };
    }
    return consumed['reservation_id'] === input.reservationId && input.outcome === 'consume'
      ? { status: 200, record }
      : { status: 409 };
  }

  private settleVaultState(
    input: ResolveVaultSettleRequest,
    settledAt: number,
  ): { readonly status: 200; readonly record: SessionRecord } | { readonly status: 401 | 409 } {
    return this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, settledAt) || record === null) {
        return { status: 401 } as const;
      }
      this.pruneResolveStorage(settledAt);
      const row = this.readVaultCandidate(input.resolveId, input.candidateId);
      if (row === undefined) {
        return this.settleMissingVaultCandidate(input, settledAt, record);
      }
      if (row['session_hash'] !== input.sessionHash) {
        return { status: 401 } as const;
      }
      if (input.outcome === 'consume') {
        if (row['reservation_id'] === input.reservationId) {
          this.ctx.storage.sql.exec(
            `UPDATE resolved_media_candidates
             SET reservation_id = NULL, reservation_expires_at = NULL
             WHERE resolve_id = ? AND candidate_id = ? AND reservation_id = ?`,
            input.resolveId,
            input.candidateId,
            input.reservationId,
          );
        }
        return { status: 200, record } as const;
      }
      if (row['reservation_id'] !== input.reservationId) {
        return row['reservation_id'] === null && input.outcome === 'release'
          ? ({ status: 200, record } as const)
          : ({ status: 409 } as const);
      }
      this.ctx.storage.sql.exec(
        `UPDATE resolved_media_candidates
         SET reservation_id = NULL, reservation_expires_at = NULL
         WHERE resolve_id = ? AND candidate_id = ? AND reservation_id = ?`,
        input.resolveId,
        input.candidateId,
        input.reservationId,
      );
      return { status: 200, record } as const;
    });
  }

  private async settleVault(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeResolveVaultSettleRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    let result: ReturnType<SessionCoordinator['settleVaultState']>;
    try {
      result = this.settleVaultState(input, Date.now());
    } catch {
      return safeJson(500, { ok: false });
    }
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    try {
      await this.scheduleAlarm(result.record);
    } catch {
      return safeJson(500, { ok: false });
    }
    return safeJson(200, { ok: true });
  }

  private async createSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeCreateSessionRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const transition = createSessionRecord(this.readRecord(), input, Date.now());
      if (transition.allowed) {
        this.writeRecord(transition.record);
      }
      return transition;
    });
    if (!result.allowed) {
      return safeJson(result.reason === 'exists' ? 409 : 400, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(200, { ok: true, expiresAt: result.record.expiresAt });
  }

  private async resumeSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeResumeSessionRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const transition = resumeSessionRecord(this.readRecord(), input, Date.now());
      if (transition.allowed) {
        this.writeRecord(transition.record);
      }
      return transition;
    });
    if (!result.allowed) {
      return safeJson(410, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(200, { ok: true, expiresAt: result.record.expiresAt });
  }

  private async authorize(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAuthorizeSessionRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return authorizeSessionRecord(this.readRecord(), input, input.now)
      ? safeJson(200, { ok: true })
      : safeJson(401, { ok: false });
  }

  private async acquireSessionDownloadPermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAcquireSessionDownloadPermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return this.ctx.blockConcurrencyWhile(() => this.acquireSessionDownloadPermitDecoded(input));
  }

  private async acquireSessionDownloadPermitDecoded(
    input: AcquireSessionDownloadPermitRequest,
  ): Promise<Response> {
    const acquiredAt = Date.now();
    let result:
      | {
          readonly status: 201;
          readonly record: SessionRecord;
          readonly permit: SessionDownloadPermit;
          readonly newlyAdmitted: boolean;
        }
      | { readonly status: SessionDownloadAdmissionHttpErrorStatus };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const record = this.readRecord();
        if (
          record?.sessionHash !== input.sessionHash ||
          record.expiresAt - acquiredAt < SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS
        ) {
          return { status: 401 } as const;
        }
        const current = this.readSessionDownloadState();
        const newlyAdmitted = !current.permits.some((permit) => permit.permitId === input.permitId);
        try {
          const transition = acquireSessionDownloadPermit(current, {
            now: acquiredAt,
            sessionExpiresAt: record.expiresAt,
            permitId: input.permitId,
            downloadId: input.downloadId,
          });
          this.writeSessionDownloadState(transition.state);
          return {
            status: 201,
            record,
            permit: transition.permit,
            newlyAdmitted,
          } as const;
        } catch (error: unknown) {
          if (error instanceof SessionDownloadAdmissionStateError) {
            return { status: sessionDownloadAdmissionErrorStatus(error) } as const;
          }
          throw error;
        }
      });
    } catch {
      return safeJson(500, { ok: false });
    }
    if (result.status !== 201) {
      return safeJson(result.status, { ok: false });
    }
    try {
      await this.scheduleAlarm(result.record);
    } catch {
      if (result.newlyAdmitted) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            `DELETE FROM session_download_permits
             WHERE permit_id = ? AND download_id = ? AND sequence = ?
               AND acquired_at = ? AND renewed_at = ? AND expires_at = ?`,
            result.permit.permitId,
            result.permit.downloadId,
            result.permit.sequence,
            result.permit.acquiredAt,
            result.permit.renewedAt,
            result.permit.expiresAt,
          );
        });
      }
      return safeJson(500, { ok: false });
    }
    return safeJson(201, {
      ok: true,
      permitId: result.permit.permitId,
      sequence: result.permit.sequence,
      expiresAt: result.permit.expiresAt,
    });
  }

  private async renewSessionDownloadPermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeRenewSessionDownloadPermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return this.ctx.blockConcurrencyWhile(() => this.renewSessionDownloadPermitDecoded(input));
  }

  private async renewSessionDownloadPermitDecoded(
    input: RenewSessionDownloadPermitRequest,
  ): Promise<Response> {
    const renewedAt = Date.now();
    let result:
      | {
          readonly status: 200;
          readonly record: SessionRecord;
          readonly permit: SessionDownloadPermit;
          readonly previous: SessionDownloadPermit;
          readonly state: SessionDownloadAdmissionState;
          readonly advanced: boolean;
        }
      | { readonly status: SessionDownloadAdmissionHttpErrorStatus };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const record = this.readRecord();
        if (
          record?.sessionHash !== input.sessionHash ||
          record.expiresAt - renewedAt < SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS
        ) {
          return { status: 401 } as const;
        }
        const current = this.readSessionDownloadState();
        const previous = current.permits.find((permit) => permit.permitId === input.permitId);
        if (previous === undefined) {
          return { status: 409 } as const;
        }
        try {
          const transition = renewSessionDownloadPermit(current, {
            now: renewedAt,
            sessionExpiresAt: record.expiresAt,
            permitId: input.permitId,
            downloadId: input.downloadId,
            sequence: input.sequence,
          });
          const advanced = transition.permit.sequence > previous.sequence;
          if (advanced) {
            this.compareAndSwapSessionDownloadPermit(previous, transition.permit);
          }
          this.deleteExpiredSessionDownloadPermits(current, transition.state, renewedAt);
          return {
            status: 200,
            record,
            permit: transition.permit,
            previous,
            state: transition.state,
            advanced,
          } as const;
        } catch (error: unknown) {
          if (error instanceof SessionDownloadAdmissionStateError) {
            return { status: sessionDownloadAdmissionErrorStatus(error) } as const;
          }
          throw error;
        }
      });
    } catch {
      return safeJson(500, { ok: false });
    }
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    try {
      await this.scheduleAlarm(result.record, result.state);
    } catch {
      if (result.advanced) {
        this.ctx.storage.transactionSync(() => {
          this.compareAndSwapSessionDownloadPermit(result.permit, result.previous);
        });
      }
      return safeJson(500, { ok: false });
    }
    return safeJson(200, {
      ok: true,
      permitId: result.permit.permitId,
      sequence: result.permit.sequence,
      expiresAt: result.permit.expiresAt,
    });
  }

  private async releaseSessionDownloadPermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeReleaseSessionDownloadPermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return this.ctx.blockConcurrencyWhile(() => this.releaseSessionDownloadPermitDecoded(input));
  }

  private async releaseSessionDownloadPermitDecoded(
    input: ReleaseSessionDownloadPermitRequest,
  ): Promise<Response> {
    const releasedAt = Date.now();
    let result:
      | { readonly status: 200; readonly record: SessionRecord }
      | { readonly status: SessionDownloadAdmissionHttpErrorStatus };
    try {
      result = this.ctx.storage.transactionSync(() => {
        const record = this.readRecord();
        if (record?.sessionHash !== input.sessionHash) {
          return { status: 401 } as const;
        }
        try {
          const state = releaseSessionDownloadPermit(this.readSessionDownloadState(), {
            now: releasedAt,
            permitId: input.permitId,
            downloadId: input.downloadId,
          });
          this.writeSessionDownloadState(state);
          return { status: 200, record } as const;
        } catch (error: unknown) {
          if (error instanceof SessionDownloadAdmissionStateError) {
            return { status: sessionDownloadAdmissionErrorStatus(error) } as const;
          }
          throw error;
        }
      });
    } catch {
      return safeJson(500, { ok: false });
    }
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    try {
      await this.scheduleAlarm(result.record);
    } catch {
      return safeJson(500, { ok: false });
    }
    return safeJson(200, { ok: true });
  }

  private async acquirePermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAcquireResolvePermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, input.now) || record === null) {
        return { status: 401 } as const;
      }
      this.pruneResolveStorage(input.now);
      try {
        const next = acquireResolvePermit(this.readResolveState(), input.now, input.permitId);
        const permit = next.permits.find((candidate) => candidate.id === input.permitId)!;
        this.ctx.storage.sql.exec('INSERT INTO resolve_events (event_at) VALUES (?)', input.now);
        this.ctx.storage.sql.exec(
          'INSERT INTO resolve_permits (permit_id, expires_at) VALUES (?, ?)',
          permit.id,
          permit.expiresAt,
        );
        return { status: 201, record, expiresAt: permit.expiresAt } as const;
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return { status: error.code === 'RESOLVE_RATE_INVALID' ? 400 : 429 } as const;
        }
        throw error;
      }
    });
    if (result.status !== 201) {
      return safeJson(result.status, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(201, { ok: true, expiresAt: result.expiresAt });
  }

  private async releasePermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeReleaseResolvePermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (
        record?.sessionHash !== input.sessionHash ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0 ||
        input.now >= record.expiresAt
      ) {
        return { status: 401 } as const;
      }
      this.pruneResolveStorage(input.now);
      try {
        releaseResolvePermit(this.readResolveState(), input.now, input.permitId);
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return { status: 400 } as const;
        }
        throw error;
      }
      this.ctx.storage.sql.exec('DELETE FROM resolve_permits WHERE permit_id = ?', input.permitId);
      return { status: 200, record } as const;
    });
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(200, { ok: true });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return safeJson(404, { ok: false });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/create') {
      return this.createSession(request);
    }
    if (pathname === '/resume') {
      return this.resumeSession(request);
    }
    if (pathname === '/authorize') {
      return this.authorize(request);
    }
    if (pathname === '/resolve-permits/acquire') {
      return this.acquirePermit(request);
    }
    if (pathname === '/resolve-permits/release') {
      return this.releasePermit(request);
    }
    if (pathname === '/download-permits/acquire') {
      return this.acquireSessionDownloadPermit(request);
    }
    if (pathname === '/download-permits/renew') {
      return this.renewSessionDownloadPermit(request);
    }
    if (pathname === '/download-permits/release') {
      return this.releaseSessionDownloadPermit(request);
    }
    if (pathname === '/resolve-vault/store') {
      return this.storeVault(request);
    }
    if (pathname === '/resolve-vault/claim') {
      return this.claimVault(request);
    }
    if (pathname === '/resolve-vault/settle') {
      return this.settleVault(request);
    }
    return safeJson(404, { ok: false });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const decision = sessionAlarmDecision(this.readRecord(), now);
    if (decision.action === 'delete') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.initializeTables();
      return;
    }
    const downloadState = this.ctx.storage.transactionSync(() => {
      this.pruneResolveStorage(now);
      return this.pruneSessionDownloadStorage(now);
    });
    await this.scheduleAlarm(this.readRecord()!, downloadState);
  }
}
