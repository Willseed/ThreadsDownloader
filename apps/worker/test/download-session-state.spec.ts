import { describe, expect, it } from 'vitest';

import {
  acquireDownloadStream,
  DOWNLOAD_ABSOLUTE_LIFETIME_MS,
  DOWNLOAD_COMPLETION_GRACE_MS,
  DOWNLOAD_IDLE_DEADLINE_MS,
  DOWNLOAD_START_DEADLINE_MS,
  decideDownloadAlarm,
  DownloadSessionStateError,
  finishDownloadStream,
  inspectDownloadSession,
  interruptDownloadStream,
  issueDownloadSession,
  renewDownloadStream,
  type DownloadSessionState,
} from '../src/security/download-session-state.js';
import { createOpaqueId } from '../src/security/cryptography.js';
import { RangeTransferError, type ReliableValidator } from '../src/security/range-transfer.js';

const NOW = 1_000_000;
const ETAG: ReliableValidator = { kind: 'etag', value: '"v1"' };
const HOLDERS = new Map<string, string>();

function holder(label: string): string {
  const existing = HOLDERS.get(label);
  if (existing !== undefined) {
    return existing;
  }
  const created = createOpaqueId(192);
  HOLDERS.set(label, created);
  return created;
}

function issued(
  overrides: Partial<{
    readonly total: number | null;
    readonly validator: ReliableValidator | null;
  }> = {},
): DownloadSessionState {
  return issueDownloadSession({
    now: NOW,
    total: 100,
    validator: ETAG,
    ...overrides,
  });
}

function expectStateError(action: () => unknown, code: string): void {
  expect(action).toThrowError(DownloadSessionStateError);
  try {
    action();
  } catch (error) {
    expect((error as DownloadSessionStateError).code).toBe(code);
  }
}

function expectRangeError(action: () => unknown, code: string, contentRange?: string): void {
  expect(action).toThrowError(RangeTransferError);
  try {
    action();
  } catch (error) {
    expect((error as RangeTransferError).code).toBe(code);
    expect((error as RangeTransferError).contentRange).toBe(contentRange);
  }
}

function acquireFull(
  state: DownloadSessionState,
  holderLabel: string,
  now: number,
): ReturnType<typeof acquireDownloadStream> {
  return acquireDownloadStream(state, {
    now,
    holderId: holder(holderLabel),
    rangeHeader: null,
    ifRangeHeader: null,
  });
}

function finishFull(
  state: DownloadSessionState,
  holderLabel: string,
  now: number,
  overrides: Partial<{
    readonly sequence: number;
    readonly normalEof: boolean;
    readonly actualBytes: number;
    readonly etag: string;
  }> = {},
): DownloadSessionState {
  return finishDownloadStream(state, {
    now,
    holderId: holder(holderLabel),
    sequence: overrides.sequence ?? 0,
    normalEof: overrides.normalEof ?? true,
    actualBytes: overrides.actualBytes ?? 100,
    upstream: {
      status: 200,
      headers: new Headers({
        'content-length': '100',
        etag: overrides.etag ?? '"v1"',
      }),
    },
  });
}

function finishRange(
  state: DownloadSessionState,
  holderLabel: string,
  now: number,
  start: number,
  end: number,
  total: number,
): DownloadSessionState {
  return finishDownloadStream(state, {
    now,
    holderId: holder(holderLabel),
    sequence: 0,
    normalEof: true,
    actualBytes: end - start + 1,
    upstream: {
      status: 206,
      headers: new Headers({
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${total}`,
        etag: '"v1"',
      }),
    },
  });
}

describe('download session issue and inspection', () => {
  it('issues fixed start and absolute deadlines with cloned representation metadata', () => {
    const validator: ReliableValidator = { kind: 'etag', value: '"v1"' };
    const state = issueDownloadSession({ now: NOW, total: 100, validator });

    expect(state).toMatchObject({
      status: 'ISSUED',
      issuedAt: NOW,
      startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS,
      absoluteExpiresAt: NOW + DOWNLOAD_ABSOLUTE_LIFETIME_MS,
      idleExpiresAt: null,
      completionExpiresAt: null,
      lastActivityAt: null,
      representation: { total: 100, validator },
      completedIntervals: [],
      leases: [],
    });
    expect(state.representation.validator).not.toBe(validator);
  });

  it('rejects invalid totals and unreliable validator metadata', () => {
    expectStateError(
      () => issueDownloadSession({ now: NOW, total: 0, validator: ETAG }),
      'DOWNLOAD_STATE_INVALID',
    );
    expectStateError(
      () =>
        issueDownloadSession({
          now: NOW,
          total: 100,
          validator: { kind: 'etag', value: 'W/"v1"' },
        }),
      'DOWNLOAD_STATE_INVALID',
    );
    expectStateError(
      () =>
        issueDownloadSession({
          now: NOW,
          total: 100,
          validator: {
            kind: 'other',
            value: 'Mon, 01 Jan 2024 00:00:00 GMT',
          } as unknown as ReliableValidator,
        }),
      'DOWNLOAD_STATE_INVALID',
    );
  });

  it('projects exact start expiry without mutating durable state', () => {
    const state = issued();
    const snapshot = structuredClone(state);

    expect(inspectDownloadSession(state, state.startExpiresAt)).toMatchObject({
      status: 'EXPIRED',
      available: false,
      activeStreams: 0,
    });
    expect(state).toEqual(snapshot);
  });

  it('does not prune stale leases during inspection', () => {
    const first = acquireDownloadStream(issued(), {
      now: NOW,
      holderId: holder('holder_1'),
      rangeHeader: null,
      ifRangeHeader: null,
    });
    const second = acquireDownloadStream(first.state, {
      now: NOW + 400_000,
      holderId: holder('holder_2'),
      rangeHeader: null,
      ifRangeHeader: null,
    });
    const snapshot = structuredClone(second.state);

    expect(inspectDownloadSession(second.state, first.lease.expiresAt)).toMatchObject({
      status: 'ACTIVE',
      available: true,
      activeStreams: 2,
    });
    expect(second.state).toEqual(snapshot);
  });

  it('rejects malformed persisted state with typed errors instead of native exceptions', () => {
    const active = acquireFull(issued(), 'holder_malformed_state', NOW).state;
    const malformed: readonly unknown[] = [
      null,
      { ...issued(), representation: null },
      { ...issued(), leases: null },
      { ...issued(), completedIntervals: [null] },
      { ...active, leases: [null] },
      {
        ...issued(),
        representation: {
          total: 100,
          validator: { kind: 'etag', value: 42 },
        },
      },
    ];

    for (const state of malformed) {
      expectStateError(
        () => inspectDownloadSession(state as DownloadSessionState, NOW),
        'DOWNLOAD_STATE_INVALID',
      );
    }
  });

  it('rejects null operation inputs with typed state errors', () => {
    const active = acquireFull(issued(), 'holder_null_input', NOW).state;
    const actions = [
      () => issueDownloadSession(null as never),
      () => acquireDownloadStream(issued(), null as never),
      () => renewDownloadStream(active, null as never),
      () => finishDownloadStream(active, null as never),
      () => interruptDownloadStream(active, null as never),
    ];

    for (const action of actions) {
      expectStateError(action, 'DOWNLOAD_STATE_INVALID');
    }
  });
});

describe('download stream acquisition', () => {
  it('accepts immediately before the start deadline and rejects its exact boundary', () => {
    const state = issued();
    expect(
      acquireDownloadStream(state, {
        now: state.startExpiresAt - 1,
        holderId: holder('holder_before'),
        rangeHeader: null,
        ifRangeHeader: null,
      }).state.status,
    ).toBe('ACTIVE');
    expectStateError(
      () =>
        acquireDownloadStream(state, {
          now: state.startExpiresAt,
          holderId: holder('holder_exact'),
          rangeHeader: null,
          ifRangeHeader: null,
        }),
      'DOWNLOAD_EXPIRED',
    );
  });

  it('canonicalizes one satisfiable range and returns a cloned representation pin', () => {
    const result = acquireDownloadStream(issued(), {
      now: NOW,
      holderId: holder('holder_range'),
      rangeHeader: 'bytes=10-999',
      ifRangeHeader: '"v1"',
    });

    expect(result.request).toEqual({
      requestedInterval: { start: 10, end: 99, total: 100 },
      representationPin: { total: 100, validator: ETAG },
    });
    expect(result.request.representationPin?.validator).not.toBe(ETAG);
    expect(result.lease.requestedInterval).toEqual(result.request.requestedInterval);
    expect(result.lease.requestedInterval).not.toBe(result.request.requestedInterval);
  });

  it.each(['W/"v1"', '"other"'])(
    'falls back to a full request for mismatched If-Range %s',
    (value) => {
      expect(
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder(`holder_full_${value}`),
          rangeHeader: 'bytes=10-19',
          ifRangeHeader: value,
        }).request.requestedInterval,
      ).toBeNull();
    },
  );

  it('rejects a range with unknown total while allowing a full unpinned request', () => {
    const state = issued({ total: null, validator: null });
    expectStateError(
      () =>
        acquireDownloadStream(state, {
          now: NOW,
          holderId: holder('holder_unknown_range'),
          rangeHeader: 'bytes=0-9',
          ifRangeHeader: null,
        }),
      'DOWNLOAD_RANGE_UNAVAILABLE',
    );
    expect(
      acquireDownloadStream(state, {
        now: NOW,
        holderId: holder('holder_unknown_full'),
        rangeHeader: null,
        ifRangeHeader: null,
      }).request,
    ).toEqual({ requestedInterval: null, representationPin: null });
  });

  it('ignores unknown total and malformed Range when If-Range requires a full request', () => {
    expect(
      acquireDownloadStream(issued({ total: null }), {
        now: NOW,
        holderId: holder('holder_unknown_mismatch'),
        rangeHeader: 'not-a-range',
        ifRangeHeader: '"other"',
      }).request,
    ).toEqual({ requestedInterval: null, representationPin: null });
  });

  it.each(['not-a-range', 'bytes=0-1,2-3', 'bytes=100-', 'bytes=0-999'])(
    'ignores Range %s when If-Range mismatches',
    (rangeHeader) => {
      expect(
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder(`holder_ignored_${rangeHeader}`),
          rangeHeader,
          ifRangeHeader: '"other"',
        }).request.requestedInterval,
      ).toBeNull();
    },
  );

  it.each([null, '"v1"'])('preserves Range failures when If-Range is %s', (ifRangeHeader) => {
    expectRangeError(
      () =>
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder(`holder_multi_${String(ifRangeHeader)}`),
          rangeHeader: 'bytes=0-1,2-3',
          ifRangeHeader,
        }),
      'RANGE_INVALID',
      'bytes */100',
    );
    expectRangeError(
      () =>
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder(`holder_unsatisfied_${String(ifRangeHeader)}`),
          rangeHeader: 'bytes=100-',
          ifRangeHeader,
        }),
      'RANGE_NOT_SATISFIABLE',
      'bytes */100',
    );
  });

  it('rejects low-entropy noncanonical holder identifiers', () => {
    expectStateError(
      () =>
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: 'low_entropy',
          rangeHeader: null,
          ifRangeHeader: null,
        }),
      'DOWNLOAD_LEASE_INVALID',
    );
  });

  it('rejects non-string Range metadata with typed state errors', () => {
    expectStateError(
      () =>
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder('holder_number_range'),
          rangeHeader: 42 as unknown as string,
          ifRangeHeader: null,
        }),
      'DOWNLOAD_STATE_INVALID',
    );
    expectStateError(
      () =>
        acquireDownloadStream(issued(), {
          now: NOW,
          holderId: holder('holder_object_if_range'),
          rangeHeader: 'bytes=0-9',
          ifRangeHeader: {} as unknown as string,
        }),
      'DOWNLOAD_STATE_INVALID',
    );
  });

  it('admits four parallel holders and rejects a duplicate or fifth holder', () => {
    let state = issued();
    for (let index = 0; index < 4; index += 1) {
      state = acquireDownloadStream(state, {
        now: NOW + index,
        holderId: holder(`holder_${index}`),
        rangeHeader: null,
        ifRangeHeader: null,
      }).state;
    }
    expect(state.leases).toHaveLength(4);
    expectStateError(
      () =>
        acquireDownloadStream(state, {
          now: NOW + 4,
          holderId: holder('holder_0'),
          rangeHeader: null,
          ifRangeHeader: null,
        }),
      'DOWNLOAD_LEASE_INVALID',
    );
    expectStateError(
      () =>
        acquireDownloadStream(state, {
          now: NOW + 4,
          holderId: holder('holder_4'),
          rangeHeader: null,
          ifRangeHeader: null,
        }),
      'DOWNLOAD_CONCURRENT_LIMIT',
    );
  });
});

describe('download stream renewal', () => {
  it('renews only its holder with a strictly higher sequence', () => {
    const acquired = acquireDownloadStream(issued(), {
      now: NOW,
      holderId: holder('holder_renew'),
      rangeHeader: null,
      ifRangeHeader: null,
    });
    const renewed = renewDownloadStream(acquired.state, {
      now: NOW + 1,
      holderId: holder('holder_renew'),
      sequence: 2,
    });

    expect(renewed.lease).toMatchObject({ sequence: 2, renewedAt: NOW + 1 });
    expectStateError(
      () =>
        renewDownloadStream(renewed.state, {
          now: NOW + 2,
          holderId: holder('holder_renew'),
          sequence: 2,
        }),
      'DOWNLOAD_SEQUENCE_INVALID',
    );
    expectStateError(
      () =>
        renewDownloadStream(renewed.state, {
          now: NOW + 2,
          holderId: holder('other_holder'),
          sequence: 3,
        }),
      'DOWNLOAD_LEASE_INVALID',
    );
  });

  it('rejects renewal at the exact idle boundary', () => {
    const acquired = acquireDownloadStream(issued(), {
      now: NOW,
      holderId: holder('holder_idle'),
      rangeHeader: null,
      ifRangeHeader: null,
    });
    expectStateError(
      () =>
        renewDownloadStream(acquired.state, {
          now: NOW + DOWNLOAD_IDLE_DEADLINE_MS,
          holderId: holder('holder_idle'),
          sequence: 1,
        }),
      'DOWNLOAD_EXPIRED',
    );
  });

  it('caps renewed lease and idle deadlines at the absolute lifetime', () => {
    const acquired = acquireDownloadStream(issued(), {
      now: NOW,
      holderId: holder('holder_absolute'),
      rangeHeader: null,
      ifRangeHeader: null,
    });
    let state = acquired.state;
    let lease = acquired.lease;
    const offsets = [
      500_000,
      1_000_000,
      1_500_000,
      2_000_000,
      2_500_000,
      3_000_000,
      3_500_000,
      DOWNLOAD_ABSOLUTE_LIFETIME_MS - 1,
    ];
    for (const [index, offset] of offsets.entries()) {
      const renewed = renewDownloadStream(state, {
        now: NOW + offset,
        holderId: holder('holder_absolute'),
        sequence: index + 1,
      });
      state = renewed.state;
      lease = renewed.lease;
    }

    expect(lease.expiresAt).toBe(NOW + DOWNLOAD_ABSOLUTE_LIFETIME_MS);
    expect(state.idleExpiresAt).toBe(NOW + DOWNLOAD_ABSOLUTE_LIFETIME_MS);
  });
});

describe('download stream completion', () => {
  it('enters completion grace only after an exact reliable full transfer', () => {
    const acquired = acquireFull(issued(), 'holder_complete', NOW);
    const snapshot = structuredClone(acquired.state);
    const completed = finishFull(acquired.state, 'holder_complete', NOW + 1);

    expect(completed).toMatchObject({
      status: 'COMPLETE_PENDING',
      lastActivityAt: NOW + 1,
      completionExpiresAt: NOW + 1 + DOWNLOAD_COMPLETION_GRACE_MS,
      completedIntervals: [{ start: 0, end: 99, total: 100 }],
      leases: [],
    });
    expect(acquired.state).toEqual(snapshot);
  });

  it.each([
    ['short EOF', { actualBytes: 99 }],
    ['overlong EOF', { actualBytes: 101 }],
    ['non-normal EOF', { normalEof: false }],
    ['forged truthy EOF', { normalEof: 'yes' as unknown as boolean }],
  ] as const)('does not credit %s', (name, evidence) => {
    const label = `holder_unreliable_${name}`;
    const acquired = acquireFull(issued(), label, NOW);
    const result = finishFull(acquired.state, label, NOW + 1, evidence);

    expect(result.status).toBe('INTERRUPTED');
    expect(result.completedIntervals).toEqual([]);
    expect(result.completionExpiresAt).toBeNull();
  });

  it('does not credit a forged upstream success status', () => {
    const acquired = acquireFull(issued(), 'holder_status', NOW);
    const result = finishDownloadStream(acquired.state, {
      now: NOW + 1,
      holderId: holder('holder_status'),
      sequence: 0,
      normalEof: true,
      actualBytes: 100,
      upstream: {
        status: 201 as unknown as 200,
        headers: new Headers({ 'content-length': '100', etag: '"v1"' }),
      },
    });

    expect(result).toMatchObject({
      status: 'INTERRUPTED',
      completedIntervals: [],
      completionExpiresAt: null,
    });
  });

  it.each([
    null,
    {},
    { status: 200, headers: null },
    { status: 200, headers: { get: 'not-callable' } },
  ])('safely interrupts malformed upstream evidence %#', (upstream) => {
    const label = `holder_malformed_upstream_${JSON.stringify(upstream)}`;
    const acquired = acquireFull(issued(), label, NOW);
    const result = finishDownloadStream(acquired.state, {
      now: NOW + 1,
      holderId: holder(label),
      sequence: 0,
      normalEof: true,
      actualBytes: 100,
      upstream: upstream as never,
    });

    expect(result).toMatchObject({
      status: 'INTERRUPTED',
      completedIntervals: [],
      completionExpiresAt: null,
    });
  });

  it('rejects forged partial completion state during inspection', () => {
    const completed = finishFull(
      acquireFull(issued(), 'holder_forged_complete', NOW).state,
      'holder_forged_complete',
      NOW + 1,
    );
    const forged: DownloadSessionState = {
      ...completed,
      completedIntervals: [{ start: 0, end: 49, total: 100 }],
    };

    expectStateError(() => inspectDownloadSession(forged, NOW + 2), 'DOWNLOAD_STATE_INVALID');
  });

  it('does not complete across mismatched or unknown representation evidence', () => {
    const mismatch = acquireFull(issued(), 'holder_mismatch', NOW);
    expect(
      finishFull(mismatch.state, 'holder_mismatch', NOW + 1, { etag: '"other"' }),
    ).toMatchObject({ status: 'INTERRUPTED', completedIntervals: [] });

    const unknownTotal = acquireFull(
      issued({ total: null, validator: ETAG }),
      'holder_unknown_total',
      NOW,
    );
    expect(finishFull(unknownTotal.state, 'holder_unknown_total', NOW + 1)).toMatchObject({
      status: 'INTERRUPTED',
      completedIntervals: [],
    });

    const unknownValidator = acquireFull(
      issued({ total: 100, validator: null }),
      'holder_unknown_validator',
      NOW,
    );
    expect(finishFull(unknownValidator.state, 'holder_unknown_validator', NOW + 1)).toMatchObject({
      status: 'INTERRUPTED',
      completedIntervals: [],
    });
  });

  it('merges out-of-order reliable ranges into exact full coverage', () => {
    const state = issued({ total: 10 });
    const upper = acquireDownloadStream(state, {
      now: NOW,
      holderId: holder('holder_upper'),
      rangeHeader: 'bytes=5-9',
      ifRangeHeader: '"v1"',
    });
    const interrupted = finishRange(upper.state, 'holder_upper', NOW + 1, 5, 9, 10);
    expect(interrupted).toMatchObject({
      status: 'INTERRUPTED',
      completedIntervals: [{ start: 5, end: 9, total: 10 }],
    });

    const lower = acquireDownloadStream(interrupted, {
      now: NOW + 2,
      holderId: holder('holder_lower'),
      rangeHeader: 'bytes=0-4',
      ifRangeHeader: '"v1"',
    });
    expect(finishRange(lower.state, 'holder_lower', NOW + 3, 0, 4, 10)).toMatchObject({
      status: 'COMPLETE_PENDING',
      completedIntervals: [{ start: 0, end: 9, total: 10 }],
    });
  });

  it('waits for every parallel lease to finish normally before completion', () => {
    const lower = acquireDownloadStream(issued({ total: 10 }), {
      now: NOW,
      holderId: holder('holder_parallel_lower'),
      rangeHeader: 'bytes=0-4',
      ifRangeHeader: '"v1"',
    });
    const upper = acquireDownloadStream(lower.state, {
      now: NOW + 1,
      holderId: holder('holder_parallel_upper'),
      rangeHeader: 'bytes=5-9',
      ifRangeHeader: '"v1"',
    });
    const first = finishRange(upper.state, 'holder_parallel_lower', NOW + 2, 0, 4, 10);
    expect(first).toMatchObject({
      status: 'ACTIVE',
      leases: [{ holderId: holder('holder_parallel_upper') }],
    });

    expect(finishRange(first, 'holder_parallel_upper', NOW + 3, 5, 9, 10).status).toBe(
      'COMPLETE_PENDING',
    );
  });

  it('remains interrupted when the last parallel lease is interrupted after full coverage', () => {
    const redundant = acquireFull(issued(), 'holder_interrupt', NOW);
    const full = acquireFull(redundant.state, 'holder_full', NOW + 1);
    const covered = finishFull(full.state, 'holder_full', NOW + 2);
    expect(covered).toMatchObject({
      status: 'ACTIVE',
      completedIntervals: [{ start: 0, end: 99, total: 100 }],
    });

    const interrupted = interruptDownloadStream(covered, {
      now: NOW + 3,
      holderId: holder('holder_interrupt'),
      sequence: 0,
    });
    expect(interrupted).toMatchObject({
      status: 'INTERRUPTED',
      completionExpiresAt: null,
      completedIntervals: [{ start: 0, end: 99, total: 100 }],
    });
  });

  it('requires the exact current sequence and holder to finish or interrupt', () => {
    const acquired = acquireFull(issued(), 'holder_sequence', NOW);
    const renewed = renewDownloadStream(acquired.state, {
      now: NOW + 1,
      holderId: holder('holder_sequence'),
      sequence: 2,
    });
    expectStateError(
      () => finishFull(renewed.state, 'holder_sequence', NOW + 2, { sequence: 0 }),
      'DOWNLOAD_SEQUENCE_INVALID',
    );
    expectStateError(
      () => finishFull(renewed.state, 'other_holder', NOW + 2, { sequence: 2 }),
      'DOWNLOAD_LEASE_INVALID',
    );
    expectStateError(
      () =>
        interruptDownloadStream(renewed.state, {
          now: NOW + 2,
          holderId: holder('holder_sequence'),
          sequence: 1,
        }),
      'DOWNLOAD_SEQUENCE_INVALID',
    );

    const interrupted = interruptDownloadStream(renewed.state, {
      now: NOW + 2,
      holderId: holder('holder_sequence'),
      sequence: 2,
    });
    expect(interrupted.status).toBe('INTERRUPTED');
    expectStateError(
      () =>
        interruptDownloadStream(interrupted, {
          now: NOW + 3,
          holderId: holder('holder_sequence'),
          sequence: 2,
        }),
      'DOWNLOAD_LEASE_INVALID',
    );
  });
});

describe('bounded completion accounting and grace retry', () => {
  it('retains 64 separated intervals and rejects the 65th merged interval', () => {
    let state = issued({ total: 129 });
    for (let index = 0; index < 64; index += 1) {
      const offset = index * 2;
      const acquired = acquireDownloadStream(state, {
        now: NOW + offset,
        holderId: holder(`interval_holder_${index}`),
        rangeHeader: `bytes=${offset}-${offset}`,
        ifRangeHeader: '"v1"',
      });
      state = finishRange(
        acquired.state,
        `interval_holder_${index}`,
        NOW + offset + 1,
        offset,
        offset,
        129,
      );
    }
    expect(state.completedIntervals).toHaveLength(64);

    const acquired = acquireDownloadStream(state, {
      now: NOW + 128,
      holderId: holder('interval_holder_64'),
      rangeHeader: 'bytes=128-128',
      ifRangeHeader: '"v1"',
    });
    const snapshot = structuredClone(acquired.state);
    expectRangeError(
      () => finishRange(acquired.state, 'interval_holder_64', NOW + 129, 128, 128, 129),
      'INTERVAL_LIMIT',
    );
    expect(acquired.state).toEqual(snapshot);
  });

  it('allows retry immediately before grace expiry and rejects its exact boundary', () => {
    const acquired = acquireFull(issued(), 'holder_grace', NOW);
    const completed = finishFull(acquired.state, 'holder_grace', NOW + 1);
    const graceExpiresAt = completed.completionExpiresAt!;

    const retried = acquireFull(completed, 'holder_grace_retry', graceExpiresAt - 1);
    expect(retried.state).toMatchObject({
      status: 'ACTIVE',
      completionExpiresAt: null,
      completedIntervals: [{ start: 0, end: 99, total: 100 }],
    });
    expectStateError(
      () => acquireFull(completed, 'holder_grace_exact', graceExpiresAt),
      'DOWNLOAD_EXPIRED',
    );
  });
});

describe('download session alarms', () => {
  it('deletes at the exact start boundary without mutating the issued state', () => {
    const state = issued();
    const snapshot = structuredClone(state);
    const decision = decideDownloadAlarm(state, state.startExpiresAt);

    expect(decision).toMatchObject({
      action: 'delete',
      state: { status: 'EXPIRED', leases: [] },
    });
    expect(state).toEqual(snapshot);
  });

  it('retains until the earliest applicable future deadline', () => {
    const state = issued();
    const issuedDecision = decideDownloadAlarm(state, NOW);
    expect(issuedDecision).toEqual({
      action: 'retain',
      state,
      alarmAt: state.startExpiresAt,
    });

    const acquired = acquireFull(state, 'holder_alarm', NOW);
    const activeDecision = decideDownloadAlarm(acquired.state, NOW);
    expect(activeDecision).toMatchObject({
      action: 'retain',
      alarmAt: acquired.state.idleExpiresAt,
    });
  });

  it('prunes an old lease at exact expiry while retaining a newer holder immutably', () => {
    const first = acquireFull(issued(), 'holder_alarm_old', NOW);
    const second = acquireFull(first.state, 'holder_alarm_new', NOW + 400_000);
    const snapshot = structuredClone(second.state);
    const decision = decideDownloadAlarm(second.state, first.lease.expiresAt);

    expect(decision).toMatchObject({
      action: 'retain',
      state: {
        status: 'ACTIVE',
        leases: [{ holderId: holder('holder_alarm_new') }],
      },
      alarmAt: second.state.idleExpiresAt,
    });
    expect(second.state).toEqual(snapshot);
  });

  it('never completes when alarm pruning removes the final stale lease', () => {
    const stale = acquireFull(issued(), 'holder_alarm_stale', NOW);
    const full = acquireFull(stale.state, 'holder_alarm_full', NOW + 400_000);
    const covered = finishFull(full.state, 'holder_alarm_full', NOW + 400_001);
    expect(covered.status).toBe('ACTIVE');

    const decision = decideDownloadAlarm(covered, stale.lease.expiresAt);
    expect(decision).toMatchObject({
      action: 'retain',
      state: {
        status: 'INTERRUPTED',
        leases: [],
        completedIntervals: [{ start: 0, end: 99, total: 100 }],
      },
    });
  });

  it('deletes at exact idle, absolute, and completion-grace boundaries', () => {
    const interrupted = finishFull(
      acquireFull(issued(), 'holder_idle_alarm', NOW).state,
      'holder_idle_alarm',
      NOW + 1,
      { actualBytes: 99 },
    );
    expect(decideDownloadAlarm(interrupted, interrupted.idleExpiresAt!)).toMatchObject({
      action: 'delete',
      state: { status: 'EXPIRED' },
    });

    let active = acquireFull(issued(), 'holder_absolute_alarm', NOW);
    const offsets = [
      500_000,
      1_000_000,
      1_500_000,
      2_000_000,
      2_500_000,
      3_000_000,
      3_500_000,
      DOWNLOAD_ABSOLUTE_LIFETIME_MS - 1,
    ];
    for (const [index, offset] of offsets.entries()) {
      active = {
        ...active,
        ...renewDownloadStream(active.state, {
          now: NOW + offset,
          holderId: holder('holder_absolute_alarm'),
          sequence: index + 1,
        }),
      };
    }
    expect(decideDownloadAlarm(active.state, active.state.absoluteExpiresAt)).toMatchObject({
      action: 'delete',
      state: { status: 'EXPIRED' },
    });

    const completed = finishFull(
      acquireFull(issued(), 'holder_grace_alarm', NOW).state,
      'holder_grace_alarm',
      NOW + 1,
    );
    expect(decideDownloadAlarm(completed, completed.completionExpiresAt!)).toMatchObject({
      action: 'delete',
      state: { status: 'EXPIRED' },
    });
  });

  it('keeps an expired alarm decision terminal on later alarms', () => {
    const state = issued();
    const first = decideDownloadAlarm(state, state.startExpiresAt);
    expect(first.action).toBe('delete');
    const second = decideDownloadAlarm(first.state, state.startExpiresAt + 1);
    expect(second).toMatchObject({ action: 'delete', state: { status: 'EXPIRED', leases: [] } });
  });
});

describe('stale parallel lease race', () => {
  it('does not let an expired older lease block a newer full transfer from completing', () => {
    const stale = acquireFull(issued(), 'holder_race_stale', NOW);
    const live = acquireFull(stale.state, 'holder_race_live', NOW + 400_000);
    const snapshot = structuredClone(live.state);

    const completed = finishFull(live.state, 'holder_race_live', stale.lease.expiresAt);
    expect(completed).toMatchObject({
      status: 'COMPLETE_PENDING',
      leases: [],
      completedIntervals: [{ start: 0, end: 99, total: 100 }],
    });
    expect(live.state).toEqual(snapshot);
  });
});
