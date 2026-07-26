import { describe, expect, it } from 'vitest';

import {
  authorizeSessionRecord,
  createSessionRecord,
  resumeSessionRecord,
  sessionAlarmDecision,
  type SessionRecord,
} from '../src/security/session-record.js';

const hashA = 'A'.repeat(43);
const hashB = 'B'.repeat(43);
const hashC = 'C'.repeat(43);

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    sessionHash: hashA,
    csrfHash: hashB,
    issuedAt: 100,
    expiresAt: 1_000,
    ...overrides,
  };
}

describe('session record transitions', () => {
  it('inserts an absent session without raw credentials', () => {
    expect(
      createSessionRecord(
        null,
        { sessionHash: hashA, csrfHash: hashB, issuedAt: 100, expiresAt: 1_000 },
        100,
      ),
    ).toEqual({ allowed: true, record: record() });
  });

  it('preserves original lifetime and rotates only the CSRF hash', () => {
    expect(resumeSessionRecord(record(), { sessionHash: hashA, csrfHash: hashC }, 500)).toEqual({
      allowed: true,
      record: record({ csrfHash: hashC }),
    });
  });

  it.each([
    [record(), { sessionHash: hashC, csrfHash: hashB }, 200, 'mismatch'],
    [record(), { sessionHash: hashA, csrfHash: hashC }, 1_000, 'expired'],
    [null, { sessionHash: hashA, csrfHash: hashB }, 1_000, 'missing'],
  ])(
    'safely denies missing, mismatched, or expired resume state',
    (current, input, now, reason) => {
      expect(resumeSessionRecord(current, input, now)).toEqual({ allowed: false, reason });
    },
  );

  it('never lets create replace or revive an existing record', () => {
    expect(
      createSessionRecord(
        record({ expiresAt: 150 }),
        { sessionHash: hashC, csrfHash: hashB, issuedAt: 200, expiresAt: 1_000 },
        200,
      ),
    ).toEqual({ allowed: false, reason: 'exists' });
  });

  it('authorizes only exact hashes strictly before expiry', () => {
    expect(authorizeSessionRecord(record(), { sessionHash: hashA, csrfHash: hashB }, 999)).toBe(
      true,
    );
    expect(authorizeSessionRecord(record(), { sessionHash: hashA, csrfHash: hashB }, 1_000)).toBe(
      false,
    );
    expect(authorizeSessionRecord(record(), { sessionHash: hashA, csrfHash: hashC }, 999)).toBe(
      false,
    );
    expect(authorizeSessionRecord(null, { sessionHash: hashA, csrfHash: hashB }, 999)).toBe(false);
  });

  it('deletes missing or expired state and retains live state until its actual expiry', () => {
    expect(sessionAlarmDecision(null, 100)).toEqual({ action: 'delete' });
    expect(sessionAlarmDecision(record(), 1_000)).toEqual({ action: 'delete' });
    expect(sessionAlarmDecision(record(), 999)).toEqual({ action: 'retain', expiresAt: 1_000 });
  });
});
