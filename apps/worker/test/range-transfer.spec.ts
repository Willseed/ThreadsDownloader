import { describe, expect, it } from 'vitest';

import {
  coversFullRepresentation,
  createProbeTransferPlan,
  createTransferPlan,
  decideIfRange,
  extractRepresentationValidator,
  inspectRepresentationHeaders,
  mergeCompletedIntervals,
  parseSingleByteRange,
  pinRepresentation,
  RangeTransferError,
  representationsMatch,
  type ByteInterval,
} from '../src/security/range-transfer.js';

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function expectRangeError(action: () => unknown, code: string): void {
  expect(action).toThrowError(RangeTransferError);
  try {
    action();
  } catch (error) {
    expect((error as RangeTransferError).code).toBe(code);
    expect((error as Error).message).not.toContain('token');
  }
}

describe('parseSingleByteRange', () => {
  it.each([
    ['bytes=0-4', 10, { start: 0, end: 4, total: 10 }],
    ['bytes=5-', 10, { start: 5, end: 9, total: 10 }],
    ['bytes=0-', 10, { start: 0, end: 9, total: 10 }],
    ['bytes=-3', 10, { start: 7, end: 9, total: 10 }],
    ['bytes=-99', 10, { start: 0, end: 9, total: 10 }],
    ['bytes=0-0', 1, { start: 0, end: 0, total: 1 }],
    ['bytes=0-10', 10, { start: 0, end: 9, total: 10 }],
    ['bytes=5-999', 10, { start: 5, end: 9, total: 10 }],
  ])('resolves a single byte range', (value, total, expected) => {
    expect(parseSingleByteRange(value, total)).toEqual(expected);
  });

  it.each([
    ['items=0-1', 10, 'RANGE_INVALID'],
    ['bytes=0-1,2-3', 10, 'RANGE_INVALID'],
    ['bytes=0', 10, 'RANGE_INVALID'],
    ['bytes=-0', 10, 'RANGE_INVALID'],
    ['bytes=8-2', 10, 'RANGE_INVALID'],
    ['bytes=10-', 10, 'RANGE_NOT_SATISFIABLE'],
    ['bytes=10-10', 10, 'RANGE_NOT_SATISFIABLE'],
    ['bytes=20-30', 10, 'RANGE_NOT_SATISFIABLE'],
    ['bytes=9007199254740992-', 10, 'RANGE_INVALID'],
    ['bytes=0-9007199254740992', 10, 'RANGE_INVALID'],
  ])('rejects unsafe or unsatisfiable ranges', (value, total, code) => {
    expectRangeError(() => parseSingleByteRange(value, total), code);
  });

  it('returns a 416-safe Content-Range for range errors', () => {
    try {
      parseSingleByteRange('bytes=99-', 10);
    } catch (error) {
      expect((error as RangeTransferError).contentRange).toBe('bytes */10');
    }
  });
});

describe('validators and If-Range', () => {
  const etagHeaders = headers({ etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });
  const etag = extractRepresentationValidator(etagHeaders);

  it('prefers a strong ETag, otherwise a valid Last-Modified value', () => {
    expect(etag).toEqual({ kind: 'etag', value: '"v1"' });
    expect(
      extractRepresentationValidator(
        headers({ etag: 'W/"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }),
      ),
    ).toEqual({
      kind: 'last-modified',
      value: 'Mon, 01 Jan 2024 00:00:00 GMT',
    });
    expect(extractRepresentationValidator(headers({ etag: 'W/"v1"' }))).toBeNull();
  });

  it.each([
    [null, 'range'],
    ['"v1"', 'range'],
    ['W/"v1"', 'full'],
    ['"other"', 'full'],
    ['Mon, 01 Jan 2024 00:00:00 GMT', 'full'],
  ])('applies If-Range ETag semantics', (value, expected) => {
    expect(decideIfRange(value, etag)).toBe(expected);
  });

  it.each([
    ['Mon, 01 Jan 2024 00:00:00 GMT', 'range'],
    ['Mon, 01 Jan 2024 00:00:01 GMT', 'full'],
    ['not-a-date', 'full'],
  ])('applies exact Last-Modified semantics', (value, expected) => {
    expect(
      decideIfRange(value, { kind: 'last-modified', value: 'Mon, 01 Jan 2024 00:00:00 GMT' }),
    ).toBe(expected);
  });

  it('rejects representation validator drift', () => {
    expect(
      representationsMatch(
        { total: 10, validator: { kind: 'etag', value: '"v1"' } },
        { total: 10, validator: { kind: 'etag', value: '"v2"' } },
      ),
    ).toBe(false);
    expect(
      representationsMatch(
        { total: 10, validator: { kind: 'etag', value: '"v1"' } },
        { total: 11, validator: { kind: 'etag', value: '"v1"' } },
      ),
    ).toBe(false);
  });

  it('pins only a positive-length representation with a reliable validator', () => {
    expect(pinRepresentation(10, etagHeaders)).toEqual({
      total: 10,
      validator: { kind: 'etag', value: '"v1"' },
    });
    expect(pinRepresentation(0, etagHeaders)).toBeNull();
    expect(pinRepresentation(10, headers({ etag: 'W/"v1"' }))).toBeNull();
  });

  it('inspects length and preserves both reliable validator headers', () => {
    expect(inspectRepresentationHeaders(etagHeaders)).toEqual({
      contentLength: null,
      strongEtag: { kind: 'etag', value: '"v1"' },
      lastModified: {
        kind: 'last-modified',
        value: 'Mon, 01 Jan 2024 00:00:00 GMT',
      },
      validator: { kind: 'etag', value: '"v1"' },
    });
    expect(
      inspectRepresentationHeaders(
        headers({
          'content-length': '10',
          etag: 'W/"weak"',
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        }),
      ),
    ).toEqual({
      contentLength: 10,
      strongEtag: null,
      lastModified: {
        kind: 'last-modified',
        value: 'Mon, 01 Jan 2024 00:00:00 GMT',
      },
      validator: {
        kind: 'last-modified',
        value: 'Mon, 01 Jan 2024 00:00:00 GMT',
      },
    });
  });

  it('keeps validator extraction independent from unrelated invalid length metadata', () => {
    const source = headers({ 'content-length': 'private-invalid', etag: '"v1"' });
    expect(extractRepresentationValidator(source)).toEqual({ kind: 'etag', value: '"v1"' });
    expectRangeError(() => inspectRepresentationHeaders(source), 'UPSTREAM_RANGE_INVALID');
  });
});

describe('createTransferPlan', () => {
  const requested = { start: 2, end: 5, total: 10 };

  it('validates a matching 206 interval and content length', () => {
    expect(
      createTransferPlan({
        status: 206,
        requested,
        headers: headers({ 'content-range': 'bytes 2-5/10', 'content-length': '4', etag: '"v1"' }),
      }),
    ).toMatchObject({
      start: 2,
      end: 5,
      expectedBytes: 4,
      total: 10,
      completionReliable: true,
    });
  });

  it.each([
    [{ 'content-range': 'bytes 2-5/*' }],
    [{ 'content-range': 'bytes 2-4/10' }],
    [{ 'content-range': 'bytes 2-5/10', 'content-length': '3' }],
    [{ 'content-range': 'bytes 2-5/11' }],
    [{ 'content-range': 'bytes 5-2/10' }],
  ])('rejects malformed or inconsistent 206 headers', (values) => {
    expectRangeError(
      () => createTransferPlan({ status: 206, requested, headers: headers(values) }),
      'UPSTREAM_RANGE_INVALID',
    );
  });

  it('accepts full 200 only when its known content length is consistent', () => {
    expect(
      createTransferPlan({
        status: 200,
        requested,
        headers: headers({ 'content-length': '10', etag: '"v1"' }),
      }),
    ).toMatchObject({ start: 0, end: 9, expectedBytes: 10, total: 10, completionReliable: true });
    expectRangeError(
      () =>
        createTransferPlan({ status: 200, requested, headers: headers({ 'content-length': '9' }) }),
      'UPSTREAM_RANGE_INVALID',
    );
  });

  it('never marks unknown length or validator as completion reliable', () => {
    expect(
      createTransferPlan({ status: 200, headers: headers({ etag: '"v1"' }) }).completionReliable,
    ).toBe(false);
    expect(
      createTransferPlan({
        status: 206,
        requested,
        headers: headers({ 'content-range': 'bytes 2-5/10' }),
      }).completionReliable,
    ).toBe(false);
  });

  it('does not allow validator drift for a pinned representation', () => {
    expectRangeError(
      () =>
        createTransferPlan({
          status: 206,
          requested,
          pin: { total: 10, validator: { kind: 'etag', value: '"v1"' } },
          headers: headers({ 'content-range': 'bytes 2-5/10', etag: '"v2"' }),
        }),
      'VALIDATOR_MISMATCH',
    );
  });
});

describe('createProbeTransferPlan', () => {
  it('derives the full representation length from an exact one-byte 206 probe', () => {
    expect(
      createProbeTransferPlan({
        status: 206,
        headers: headers({
          'content-range': 'bytes 0-0/10',
          'content-length': '1',
          etag: '"v1"',
        }),
      }),
    ).toEqual({
      start: 0,
      end: 0,
      expectedBytes: 1,
      total: 10,
      validator: { kind: 'etag', value: '"v1"' },
      completionReliable: true,
    });
    expect(
      createProbeTransferPlan({
        status: 206,
        headers: headers({ 'content-range': 'bytes 0-0/10' }),
      }),
    ).toMatchObject({ expectedBytes: 1, total: 10, completionReliable: false });
  });

  it.each([
    {},
    { 'content-range': 'bytes 0-1/10' },
    { 'content-range': 'bytes 1-1/10' },
    { 'content-range': 'bytes 0-0/0' },
    { 'content-range': 'bytes 0-0/*' },
    { 'content-range': 'bytes 0-0/10', 'content-length': '0' },
    { 'content-range': 'bytes 0-0/10', 'content-length': '2' },
  ] as Record<string, string>[])(
    'rejects 206 metadata that is not an exact one-byte probe',
    (values) => {
      expectRangeError(
        () => createProbeTransferPlan({ status: 206, headers: headers(values) }),
        'UPSTREAM_RANGE_INVALID',
      );
    },
  );

  it('accepts a full 200 plan only without Content-Range metadata', () => {
    expect(
      createProbeTransferPlan({
        status: 200,
        headers: headers({ 'content-length': '10', etag: '"v1"' }),
      }),
    ).toMatchObject({ total: 10, completionReliable: true });
    expectRangeError(
      () =>
        createProbeTransferPlan({
          status: 200,
          headers: headers({ 'content-length': '10', 'content-range': 'bytes 0-9/10' }),
        }),
      'UPSTREAM_RANGE_INVALID',
    );
  });
});

describe('mergeCompletedIntervals', () => {
  const interval = (start: number, end: number): ByteInterval => ({ start, end, total: 10 });

  it('sorts and atomically merges out-of-order overlapping and adjacent intervals', () => {
    const input = [interval(5, 6), interval(0, 2), interval(2, 4), interval(7, 9)];
    expect(mergeCompletedIntervals(input, 10)).toEqual([interval(0, 9)]);
    expect(input).toEqual([interval(5, 6), interval(0, 2), interval(2, 4), interval(7, 9)]);
  });

  it('preserves a gap and only reports exact full coverage', () => {
    const gaps = mergeCompletedIntervals([interval(0, 3), interval(5, 9)], 10);
    expect(gaps).toEqual([interval(0, 3), interval(5, 9)]);
    expect(coversFullRepresentation(gaps, 10)).toBe(false);
    expect(coversFullRepresentation([interval(0, 9)], 10)).toBe(true);
  });

  it('rejects invalid bounds and more than 64 merged intervals', () => {
    expectRangeError(
      () => mergeCompletedIntervals([{ start: 0, end: 10, total: 10 }], 10),
      'INTERVAL_INVALID',
    );
    const intervals = Array.from({ length: 65 }, (_, index) => ({
      start: index * 2,
      end: index * 2,
      total: 130,
    }));
    expectRangeError(() => mergeCompletedIntervals(intervals, 130), 'INTERVAL_LIMIT');
  });
});
