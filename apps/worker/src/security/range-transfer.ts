const MAX_MERGED_INTERVALS = 64;

export type RangeTransferErrorCode =
  | 'INTERVAL_INVALID'
  | 'INTERVAL_LIMIT'
  | 'RANGE_INVALID'
  | 'RANGE_NOT_SATISFIABLE'
  | 'UPSTREAM_RANGE_INVALID'
  | 'VALIDATOR_MISMATCH';

export class RangeTransferError extends Error {
  constructor(
    readonly code: RangeTransferErrorCode,
    readonly contentRange?: string,
  ) {
    super(code);
    this.name = 'RangeTransferError';
  }
}

export interface ByteInterval {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

export interface HeaderSource {
  get(name: string): string | null;
}

export interface StrongEtagValidator {
  readonly kind: 'etag';
  readonly value: string;
}

export interface LastModifiedValidator {
  readonly kind: 'last-modified';
  readonly value: string;
}

export type ReliableValidator = StrongEtagValidator | LastModifiedValidator;

export interface RepresentationPin {
  readonly total: number;
  readonly validator: ReliableValidator;
}

export interface TransferPlan {
  readonly start: number;
  readonly end: number | null;
  readonly expectedBytes: number | null;
  readonly total: number | null;
  readonly validator: ReliableValidator | null;
  readonly completionReliable: boolean;
}

export interface UpstreamTransferInput {
  readonly status: 200 | 206;
  readonly headers: HeaderSource;
  readonly requested?: ByteInterval;
  readonly pin?: RepresentationPin;
}

export interface RepresentationHeaders {
  readonly contentLength: number | null;
  readonly strongEtag: StrongEtagValidator | null;
  readonly lastModified: LastModifiedValidator | null;
  readonly validator: ReliableValidator | null;
}

function fail(code: RangeTransferErrorCode, total?: number): never {
  throw new RangeTransferError(code, total === undefined ? undefined : `bytes */${total}`);
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertPositiveTotal(total: number): void {
  if (!Number.isSafeInteger(total) || total <= 0) {
    fail('RANGE_INVALID');
  }
}

function parseDecimal(value: string): number | null {
  if (value === '') {
    return null;
  }

  let parsed = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 48 || code > 57) {
      return null;
    }
    parsed = parsed * 10 + code - 48;
    if (!Number.isSafeInteger(parsed)) {
      return null;
    }
  }
  return parsed;
}

function parseContentLength(headers: HeaderSource): number | null {
  const value = headers.get('content-length');
  if (value === null) {
    return null;
  }
  const length = parseDecimal(value);
  if (length === null) {
    fail('UPSTREAM_RANGE_INVALID');
  }
  return length;
}

function parseStrongEtag(value: string | null): StrongEtagValidator | null {
  if (value === null || value.startsWith('W/') || value.length < 2 || !value.startsWith('"')) {
    return null;
  }
  if (!value.endsWith('"')) {
    return null;
  }
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code > 126 || code === 34) {
      return null;
    }
  }
  return { kind: 'etag', value };
}

function parseLastModified(value: string | null): LastModifiedValidator | null {
  if (
    value === null ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toUTCString() !== value
  ) {
    return null;
  }
  return { kind: 'last-modified', value };
}

function sameValidator(left: ReliableValidator, right: ReliableValidator): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function inspectRepresentationValidators(
  headers: HeaderSource,
): Omit<RepresentationHeaders, 'contentLength'> {
  const strongEtag = parseStrongEtag(headers.get('etag'));
  const lastModified = parseLastModified(headers.get('last-modified'));
  return {
    strongEtag,
    lastModified,
    validator: strongEtag ?? lastModified,
  };
}

function parseContentRange(value: string | null): ByteInterval {
  if (!value?.startsWith('bytes ')) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  const payload = value.slice('bytes '.length);
  const dash = payload.indexOf('-');
  const slash = payload.indexOf('/');
  if (dash <= 0 || slash <= dash + 1 || slash !== payload.lastIndexOf('/')) {
    return fail('UPSTREAM_RANGE_INVALID');
  }

  const start = parseDecimal(payload.slice(0, dash));
  const end = parseDecimal(payload.slice(dash + 1, slash));
  const total = parseDecimal(payload.slice(slash + 1));
  if (
    start === null ||
    end === null ||
    total === null ||
    total <= 0 ||
    start > end ||
    end >= total
  ) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  return { start, end, total };
}

export function parseSingleByteRange(value: string, total: number): ByteInterval {
  assertPositiveTotal(total);
  if (!value.startsWith('bytes=') || value.includes(',')) {
    return fail('RANGE_INVALID', total);
  }

  const specifier = value.slice('bytes='.length);
  const dash = specifier.indexOf('-');
  if (dash === -1 || dash !== specifier.lastIndexOf('-')) {
    return fail('RANGE_INVALID', total);
  }

  const first = specifier.slice(0, dash);
  const last = specifier.slice(dash + 1);
  if (first === '') {
    const suffixLength = parseDecimal(last);
    if (suffixLength === null || suffixLength === 0) {
      return fail('RANGE_INVALID', total);
    }
    const length = Math.min(suffixLength, total);
    return { start: total - length, end: total - 1, total };
  }

  const start = parseDecimal(first);
  if (start === null || start >= total) {
    return fail(start === null ? 'RANGE_INVALID' : 'RANGE_NOT_SATISFIABLE', total);
  }
  if (last === '') {
    return { start, end: total - 1, total };
  }

  const end = parseDecimal(last);
  if (end === null || start > end) {
    return fail('RANGE_INVALID', total);
  }
  return { start, end: Math.min(end, total - 1), total };
}

export function decideIfRange(
  value: string | null,
  validator: ReliableValidator | null,
): 'range' | 'full' {
  if (value === null) {
    return 'range';
  }
  if (validator === null) {
    return 'full';
  }
  if (validator.kind === 'etag') {
    return value.startsWith('W/') || value !== validator.value ? 'full' : 'range';
  }
  return parseLastModified(value)?.value === validator.value ? 'range' : 'full';
}

export function inspectRepresentationHeaders(headers: HeaderSource): RepresentationHeaders {
  return {
    contentLength: parseContentLength(headers),
    ...inspectRepresentationValidators(headers),
  };
}

export function extractRepresentationValidator(headers: HeaderSource): ReliableValidator | null {
  return inspectRepresentationValidators(headers).validator;
}

export function pinRepresentation(total: number, headers: HeaderSource): RepresentationPin | null {
  const validator = extractRepresentationValidator(headers);
  if (!Number.isSafeInteger(total) || total <= 0 || validator === null) {
    return null;
  }
  return { total, validator };
}

export function representationsMatch(
  previous: RepresentationPin,
  next: RepresentationPin,
): boolean {
  return previous.total === next.total && sameValidator(previous.validator, next.validator);
}

function createPartialTransferPlan(
  input: UpstreamTransferInput,
  validator: ReliableValidator | null,
  contentLength: number | null,
): TransferPlan {
  if (input.requested === undefined) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  const returned = parseContentRange(input.headers.get('content-range'));
  const expectedBytes = returned.end - returned.start + 1;
  if (
    returned.start !== input.requested.start ||
    returned.end !== input.requested.end ||
    returned.total !== input.requested.total ||
    (contentLength !== null && contentLength !== expectedBytes)
  ) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  if (
    input.pin !== undefined &&
    (validator === null || !representationsMatch(input.pin, { total: returned.total, validator }))
  ) {
    return fail('VALIDATOR_MISMATCH');
  }
  return {
    start: returned.start,
    end: returned.end,
    expectedBytes,
    total: returned.total,
    validator,
    completionReliable: validator !== null,
  };
}

function createFullTransferPlan(
  input: UpstreamTransferInput,
  validator: ReliableValidator | null,
  contentLength: number | null,
): TransferPlan {
  if (
    contentLength !== null &&
    input.requested !== undefined &&
    contentLength !== input.requested.total
  ) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  if (input.pin !== undefined) {
    if (
      contentLength !== input.pin.total ||
      validator === null ||
      !sameValidator(input.pin.validator, validator)
    ) {
      return fail('VALIDATOR_MISMATCH');
    }
  }
  if (contentLength === null) {
    return {
      start: 0,
      end: null,
      expectedBytes: null,
      total: null,
      validator,
      completionReliable: false,
    };
  }
  return {
    start: 0,
    end: contentLength === 0 ? null : contentLength - 1,
    expectedBytes: contentLength,
    total: contentLength,
    validator,
    completionReliable: contentLength > 0 && validator !== null,
  };
}

export function createTransferPlan(input: UpstreamTransferInput): TransferPlan {
  const validator = extractRepresentationValidator(input.headers);
  const contentLength = parseContentLength(input.headers);
  return input.status === 206
    ? createPartialTransferPlan(input, validator, contentLength)
    : createFullTransferPlan(input, validator, contentLength);
}

export function createProbeTransferPlan(input: {
  readonly status: 200 | 206;
  readonly headers: HeaderSource;
}): TransferPlan {
  if (input.status === 200) {
    if (input.headers.get('content-range') !== null) {
      return fail('UPSTREAM_RANGE_INVALID');
    }
    return createTransferPlan(input);
  }

  const returned = parseContentRange(input.headers.get('content-range'));
  if (returned.start !== 0 || returned.end !== 0) {
    return fail('UPSTREAM_RANGE_INVALID');
  }
  return createTransferPlan({ ...input, requested: returned });
}

export function mergeCompletedIntervals(
  intervals: readonly ByteInterval[],
  total: number,
): ByteInterval[] {
  assertPositiveTotal(total);
  const sorted = intervals
    .map((interval) => ({ ...interval }))
    .sort((left, right) => left.start - right.start);
  const merged: ByteInterval[] = [];
  for (const interval of sorted) {
    if (
      interval.total !== total ||
      !isSafeNonNegativeInteger(interval.start) ||
      !isSafeNonNegativeInteger(interval.end) ||
      interval.start > interval.end ||
      interval.end >= total
    ) {
      return fail('INTERVAL_INVALID');
    }
    const previous = merged.at(-1);
    if (previous !== undefined && interval.start <= previous.end + 1) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, interval.end),
        total,
      };
    } else {
      merged.push({ start: interval.start, end: interval.end, total });
    }
  }
  if (merged.length > MAX_MERGED_INTERVALS) {
    return fail('INTERVAL_LIMIT');
  }
  return merged;
}

export function coversFullRepresentation(
  intervals: readonly ByteInterval[],
  total: number,
): boolean {
  return (
    Number.isSafeInteger(total) &&
    total > 0 &&
    intervals.length === 1 &&
    intervals[0]?.start === 0 &&
    intervals[0]?.end === total - 1 &&
    intervals[0]?.total === total
  );
}
