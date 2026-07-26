export const SESSION_RECORD_SCHEMA_VERSION = 1;

export interface SessionRecord {
  readonly schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CreateSessionInput {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ResumeSessionInput {
  readonly sessionHash: string;
  readonly csrfHash: string;
}

export interface AuthorizeSessionInput {
  readonly sessionHash: string;
  readonly csrfHash: string;
}

export type CreateSessionResult =
  | { readonly allowed: true; readonly record: SessionRecord }
  | { readonly allowed: false; readonly reason: 'exists' | 'invalid' };

export type ResumeSessionResult =
  | { readonly allowed: true; readonly record: SessionRecord }
  | { readonly allowed: false; readonly reason: 'expired' | 'mismatch' | 'missing' };

function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidHash(value: string): boolean {
  return value.length === 43 && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record['schemaVersion'] === SESSION_RECORD_SCHEMA_VERSION &&
    typeof record['sessionHash'] === 'string' &&
    isValidHash(record['sessionHash']) &&
    typeof record['csrfHash'] === 'string' &&
    isValidHash(record['csrfHash']) &&
    typeof record['issuedAt'] === 'number' &&
    isValidTimestamp(record['issuedAt']) &&
    typeof record['expiresAt'] === 'number' &&
    isValidTimestamp(record['expiresAt']) &&
    record['issuedAt'] < record['expiresAt']
  );
}

export function createSessionRecord(
  current: SessionRecord | null,
  input: CreateSessionInput,
  now: number,
): CreateSessionResult {
  const candidate: SessionRecord = {
    schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
    ...input,
  };
  if (!isSessionRecord(candidate) || !isValidTimestamp(now) || now >= input.expiresAt) {
    return { allowed: false, reason: 'invalid' };
  }
  if (current !== null) {
    return { allowed: false, reason: 'exists' };
  }
  return { allowed: true, record: candidate };
}

export function resumeSessionRecord(
  current: SessionRecord | null,
  input: ResumeSessionInput,
  now: number,
): ResumeSessionResult {
  if (current === null) {
    return { allowed: false, reason: 'missing' };
  }
  if (!isValidTimestamp(now) || now >= current.expiresAt) {
    return { allowed: false, reason: 'expired' };
  }
  if (!isValidHash(input.sessionHash) || !isValidHash(input.csrfHash)) {
    return { allowed: false, reason: 'mismatch' };
  }
  if (current.sessionHash !== input.sessionHash) {
    return { allowed: false, reason: 'mismatch' };
  }
  return {
    allowed: true,
    record: { ...current, csrfHash: input.csrfHash },
  };
}

export function authorizeSessionRecord(
  current: SessionRecord | null,
  input: AuthorizeSessionInput,
  now: number,
): boolean {
  return (
    current !== null &&
    isValidTimestamp(now) &&
    now < current.expiresAt &&
    current.sessionHash === input.sessionHash &&
    current.csrfHash === input.csrfHash
  );
}

export function sessionAlarmDecision(
  current: SessionRecord | null,
  now: number,
): { readonly action: 'delete' } | { readonly action: 'retain'; readonly expiresAt: number } {
  return current === null || !isValidTimestamp(now) || now >= current.expiresAt
    ? { action: 'delete' }
    : { action: 'retain', expiresAt: current.expiresAt };
}
