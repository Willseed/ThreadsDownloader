import {
  coversFullRepresentation,
  createTransferPlan,
  decideIfRange,
  mergeCompletedIntervals,
  parseSingleByteRange,
  type ByteInterval,
  type HeaderSource,
  type ReliableValidator,
  type RepresentationPin,
} from './range-transfer.js';
import { decodeBase64Url } from '../utils/base64url.js';

export const DOWNLOAD_START_DEADLINE_MS = 120_000;
export const DOWNLOAD_IDLE_DEADLINE_MS = 600_000;
export const DOWNLOAD_ABSOLUTE_LIFETIME_MS = 3_600_000;
export const DOWNLOAD_COMPLETION_GRACE_MS = 90_000;
export const DOWNLOAD_STREAM_LEASE_MS = 900_000;
export const MAX_CONCURRENT_DOWNLOAD_STREAMS = 4;
export const MAX_DOWNLOAD_INTERVALS = 64;

export type DownloadState = 'ISSUED' | 'ACTIVE' | 'INTERRUPTED' | 'COMPLETE_PENDING' | 'EXPIRED';

export type DownloadSessionStateErrorCode =
  | 'DOWNLOAD_CONCURRENT_LIMIT'
  | 'DOWNLOAD_EXPIRED'
  | 'DOWNLOAD_LEASE_INVALID'
  | 'DOWNLOAD_RANGE_UNAVAILABLE'
  | 'DOWNLOAD_SEQUENCE_INVALID'
  | 'DOWNLOAD_STATE_INVALID';

export class DownloadSessionStateError extends Error {
  constructor(readonly code: DownloadSessionStateErrorCode) {
    super(code);
    this.name = 'DownloadSessionStateError';
  }
}

export interface DownloadRepresentation {
  readonly total: number | null;
  readonly validator: ReliableValidator | null;
}

export interface DownloadStreamLease {
  readonly holderId: string;
  readonly sequence: number;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly expiresAt: number;
  readonly requestedInterval: ByteInterval | null;
}

export interface DownloadSessionState {
  readonly status: DownloadState;
  readonly issuedAt: number;
  readonly startExpiresAt: number;
  readonly idleExpiresAt: number | null;
  readonly absoluteExpiresAt: number;
  readonly completionExpiresAt: number | null;
  readonly lastActivityAt: number | null;
  readonly representation: DownloadRepresentation;
  readonly completedIntervals: readonly ByteInterval[];
  readonly leases: readonly DownloadStreamLease[];
}

export interface IssueDownloadSessionInput {
  readonly now: number;
  readonly total: number | null;
  readonly validator: ReliableValidator | null;
}

export interface AcquireDownloadStreamInput {
  readonly now: number;
  /** Server MUST provide a fresh createOpaqueId(192) value for every acquisition and never reuse it. */
  readonly holderId: string;
  readonly rangeHeader: string | null;
  readonly ifRangeHeader: string | null;
}

export interface DownloadStreamRequestPlan {
  readonly requestedInterval: ByteInterval | null;
  readonly representationPin: RepresentationPin | null;
}

export interface AcquireDownloadStreamResult {
  readonly state: DownloadSessionState;
  readonly lease: DownloadStreamLease;
  readonly request: DownloadStreamRequestPlan;
}

export interface RenewDownloadStreamInput {
  readonly now: number;
  readonly holderId: string;
  readonly sequence: number;
  /** True only when positive-length bytes were forwarded since the last acknowledged renewal. */
  readonly progress: boolean;
}

export interface RenewDownloadStreamResult {
  readonly state: DownloadSessionState;
  readonly lease: DownloadStreamLease;
}

export interface FinishDownloadStreamInput {
  readonly now: number;
  readonly holderId: string;
  readonly sequence: number;
  readonly normalEof: boolean;
  readonly actualBytes: number;
  readonly upstream: {
    readonly status: 200 | 206;
    readonly headers: HeaderSource;
  };
}

export interface InterruptDownloadStreamInput {
  readonly now: number;
  readonly holderId: string;
  readonly sequence: number;
}

export interface DownloadSessionInspection {
  readonly status: DownloadState;
  readonly available: boolean;
  readonly startExpiresAt: number;
  readonly idleExpiresAt: number | null;
  readonly absoluteExpiresAt: number;
  readonly completionExpiresAt: number | null;
  readonly activeStreams: number;
  readonly representation: DownloadRepresentation;
}

export type DownloadAlarmDecision =
  | {
      readonly action: 'retain';
      readonly state: DownloadSessionState;
      readonly alarmAt: number;
    }
  | {
      readonly action: 'delete';
      readonly state: DownloadSessionState;
    };

function fail(code: DownloadSessionStateErrorCode): never {
  throw new DownloadSessionStateError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isHolderId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 32) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === 24;
  } catch {
    return false;
  }
}

function isStrongEtag(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('"') ||
    !value.endsWith('"') ||
    value.length < 2
  ) {
    return false;
  }
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code > 126 || code === 34) {
      return false;
    }
  }
  return true;
}

function isReliableValidator(value: unknown): value is ReliableValidator {
  if (!isRecord(value) || typeof value['value'] !== 'string') {
    return false;
  }
  if (value['kind'] === 'etag') {
    return isStrongEtag(value['value']);
  }
  if (value['kind'] === 'last-modified') {
    return (
      !Number.isNaN(Date.parse(value['value'])) &&
      new Date(value['value']).toUTCString() === value['value']
    );
  }
  return false;
}

function sameValidator(left: ReliableValidator, right: ReliableValidator): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function isHeaderSource(value: unknown): value is HeaderSource {
  if (!isRecord(value)) {
    return false;
  }
  try {
    return typeof value['get'] === 'function';
  } catch {
    return false;
  }
}

function cloneValidator(validator: ReliableValidator | null): ReliableValidator | null {
  return validator === null ? null : { ...validator };
}

function cloneInterval(interval: ByteInterval): ByteInterval {
  return { ...interval };
}

function cloneLease(lease: DownloadStreamLease): DownloadStreamLease {
  return {
    ...lease,
    requestedInterval:
      lease.requestedInterval === null ? null : cloneInterval(lease.requestedInterval),
  };
}

function cloneState(state: DownloadSessionState): DownloadSessionState {
  return {
    ...state,
    representation: {
      total: state.representation.total,
      validator: cloneValidator(state.representation.validator),
    },
    completedIntervals: state.completedIntervals.map(cloneInterval),
    leases: state.leases.map(cloneLease),
  };
}

function boundedDeadline(now: number, duration: number, absoluteExpiresAt: number): number {
  return Math.min(now + duration, absoluteExpiresAt);
}

function representationPin(representation: DownloadRepresentation): RepresentationPin | null {
  const { total, validator } = representation;
  return total === null || validator === null ? null : { total, validator: { ...validator } };
}

function validateRepresentation(representation: unknown): void {
  if (
    !isRecord(representation) ||
    (representation['total'] !== null && !isPositiveSafeInteger(representation['total'])) ||
    (representation['validator'] !== null && !isReliableValidator(representation['validator']))
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
}

function validateIntervals(
  intervals: readonly ByteInterval[],
  representation: DownloadRepresentation,
): void {
  if (
    intervals.length > MAX_DOWNLOAD_INTERVALS ||
    (intervals.length > 0 && (representation.total === null || representation.validator === null))
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  let previousEnd = -2;
  for (const interval of intervals) {
    if (
      !isRecord(interval) ||
      representation.total === null ||
      interval.total !== representation.total ||
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.start > interval.end ||
      interval.end >= interval.total ||
      interval.start <= previousEnd + 1
    ) {
      return fail('DOWNLOAD_STATE_INVALID');
    }
    previousEnd = interval.end;
  }
}

function validateLease(lease: DownloadStreamLease, state: DownloadSessionState): void {
  if (
    !isRecord(lease) ||
    state.lastActivityAt === null ||
    !isHolderId(lease.holderId) ||
    !Number.isSafeInteger(lease.sequence) ||
    lease.sequence < 0 ||
    !isSafeTimestamp(lease.acquiredAt) ||
    !isSafeTimestamp(lease.renewedAt) ||
    !isSafeTimestamp(lease.expiresAt) ||
    lease.acquiredAt < state.issuedAt ||
    lease.acquiredAt > lease.renewedAt ||
    lease.expiresAt !==
      boundedDeadline(lease.renewedAt, DOWNLOAD_STREAM_LEASE_MS, state.absoluteExpiresAt) ||
    lease.expiresAt <= lease.renewedAt
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  const interval = lease.requestedInterval;
  if (
    interval !== null &&
    (!isRecord(interval) ||
      state.representation.total === null ||
      interval.total !== state.representation.total ||
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.start > interval.end ||
      interval.end >= interval.total)
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
}

function hasStateContainers(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const intervals = value['completedIntervals'];
  const leases = value['leases'];
  return (
    isRecord(value['representation']) &&
    Array.isArray(intervals) &&
    Array.isArray(leases) &&
    !intervals.some((interval: unknown) => !isRecord(interval)) &&
    !leases.some((lease: unknown) => !isRecord(lease))
  );
}

function isDownloadState(value: unknown): value is DownloadState {
  return (
    value === 'ISSUED' ||
    value === 'ACTIVE' ||
    value === 'INTERRUPTED' ||
    value === 'COMPLETE_PENDING' ||
    value === 'EXPIRED'
  );
}

function hasValidIssueDeadlines(state: DownloadSessionState): boolean {
  return (
    isSafeTimestamp(state.issuedAt) &&
    state.issuedAt <= Number.MAX_SAFE_INTEGER - DOWNLOAD_ABSOLUTE_LIFETIME_MS &&
    state.startExpiresAt === state.issuedAt + DOWNLOAD_START_DEADLINE_MS &&
    state.absoluteExpiresAt === state.issuedAt + DOWNLOAD_ABSOLUTE_LIFETIME_MS
  );
}

function hasValidActivityDeadlines(state: DownloadSessionState): boolean {
  if (state.lastActivityAt === null) {
    return state.idleExpiresAt === null && state.completionExpiresAt === null;
  }
  if (
    !isSafeTimestamp(state.lastActivityAt) ||
    state.lastActivityAt < state.issuedAt ||
    state.lastActivityAt >= state.absoluteExpiresAt
  ) {
    return false;
  }
  return (
    (state.idleExpiresAt === null ||
      state.idleExpiresAt ===
        boundedDeadline(
          state.lastActivityAt,
          DOWNLOAD_IDLE_DEADLINE_MS,
          state.absoluteExpiresAt,
        )) &&
    (state.completionExpiresAt === null ||
      state.completionExpiresAt ===
        boundedDeadline(
          state.lastActivityAt,
          DOWNLOAD_COMPLETION_GRACE_MS,
          state.absoluteExpiresAt,
        ))
  );
}

function validateState(state: DownloadSessionState): void {
  if (!hasStateContainers(state)) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  if (
    !isDownloadState(state.status) ||
    !hasValidIssueDeadlines(state) ||
    !hasValidActivityDeadlines(state) ||
    state.leases.length > MAX_CONCURRENT_DOWNLOAD_STREAMS
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }

  validateRepresentation(state.representation);
  validateIntervals(state.completedIntervals, state.representation);
  for (const lease of state.leases) {
    validateLease(lease, state);
  }
  if (new Set(state.leases.map((lease) => lease.holderId)).size !== state.leases.length) {
    return fail('DOWNLOAD_STATE_INVALID');
  }

  const issuedShape =
    state.lastActivityAt === null &&
    state.idleExpiresAt === null &&
    state.completionExpiresAt === null &&
    state.completedIntervals.length === 0 &&
    state.leases.length === 0;
  const activeShape =
    state.lastActivityAt !== null &&
    state.idleExpiresAt !== null &&
    state.completionExpiresAt === null &&
    state.leases.length > 0;
  const interruptedShape =
    state.lastActivityAt !== null &&
    state.idleExpiresAt !== null &&
    state.completionExpiresAt === null &&
    state.leases.length === 0;
  const completeShape =
    state.lastActivityAt !== null &&
    state.idleExpiresAt !== null &&
    state.completionExpiresAt !== null &&
    state.leases.length === 0;
  if (
    (state.status === 'ISSUED' && !issuedShape) ||
    (state.status === 'ACTIVE' && !activeShape) ||
    (state.status === 'INTERRUPTED' && !interruptedShape) ||
    (state.status === 'COMPLETE_PENDING' &&
      (!completeShape ||
        state.representation.total === null ||
        state.representation.validator === null ||
        !coversFullRepresentation(state.completedIntervals, state.representation.total))) ||
    (state.status === 'EXPIRED' && state.leases.length > 0)
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
}

function validateOperationTime(state: DownloadSessionState, now: unknown): void {
  if (
    !isSafeTimestamp(now) ||
    now < state.issuedAt ||
    (state.lastActivityAt !== null && now < state.lastActivityAt)
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
}

function isLifecycleExpired(state: DownloadSessionState, now: number): boolean {
  if (state.status === 'EXPIRED' || now >= state.absoluteExpiresAt) {
    return true;
  }
  if (state.status === 'ISSUED') {
    return now >= state.startExpiresAt;
  }
  if (state.status === 'COMPLETE_PENDING') {
    return state.completionExpiresAt === null || now >= state.completionExpiresAt;
  }
  return state.idleExpiresAt === null || now >= state.idleExpiresAt;
}

function assertAvailable(state: DownloadSessionState, now: number): void {
  if (isLifecycleExpired(state, now)) {
    return fail('DOWNLOAD_EXPIRED');
  }
}

function pruneExpiredLeases(state: DownloadSessionState, now: number): DownloadSessionState {
  const leases = state.leases.filter((lease) => lease.expiresAt > now).map(cloneLease);
  const status = state.status === 'ACTIVE' && leases.length === 0 ? 'INTERRUPTED' : state.status;
  return {
    ...cloneState(state),
    status,
    leases,
  };
}

function resolveRequestedInterval(
  state: DownloadSessionState,
  rangeHeader: string | null,
  ifRangeHeader: string | null,
): ByteInterval | null {
  if (rangeHeader === null) {
    return null;
  }
  const { total, validator } = state.representation;
  if (decideIfRange(ifRangeHeader, validator) === 'full') {
    return null;
  }
  if (total === null) {
    return fail('DOWNLOAD_RANGE_UNAVAILABLE');
  }
  return parseSingleByteRange(rangeHeader, total);
}

function findLease(state: DownloadSessionState, holderId: string): DownloadStreamLease {
  const lease = state.leases.find((candidate) => candidate.holderId === holderId);
  return lease ?? fail('DOWNLOAD_LEASE_INVALID');
}

export function issueDownloadSession(input: IssueDownloadSessionInput): DownloadSessionState {
  if (
    !isRecord(input) ||
    !isSafeTimestamp(input.now) ||
    input.now > Number.MAX_SAFE_INTEGER - DOWNLOAD_ABSOLUTE_LIFETIME_MS ||
    (input.total !== null && !isPositiveSafeInteger(input.total)) ||
    (input.validator !== null && !isReliableValidator(input.validator))
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  return {
    status: 'ISSUED',
    issuedAt: input.now,
    startExpiresAt: input.now + DOWNLOAD_START_DEADLINE_MS,
    idleExpiresAt: null,
    absoluteExpiresAt: input.now + DOWNLOAD_ABSOLUTE_LIFETIME_MS,
    completionExpiresAt: null,
    lastActivityAt: null,
    representation: { total: input.total, validator: cloneValidator(input.validator) },
    completedIntervals: [],
    leases: [],
  };
}

export function inspectDownloadSession(
  state: DownloadSessionState,
  now: number,
): DownloadSessionInspection {
  validateState(state);
  validateOperationTime(state, now);
  const available = !isLifecycleExpired(state, now);
  return {
    status: available ? state.status : 'EXPIRED',
    available,
    startExpiresAt: state.startExpiresAt,
    idleExpiresAt: state.idleExpiresAt,
    absoluteExpiresAt: state.absoluteExpiresAt,
    completionExpiresAt: state.completionExpiresAt,
    activeStreams: state.leases.length,
    representation: {
      total: state.representation.total,
      validator: cloneValidator(state.representation.validator),
    },
  };
}

export function acquireDownloadStream(
  state: DownloadSessionState,
  input: AcquireDownloadStreamInput,
): AcquireDownloadStreamResult {
  validateState(state);
  if (
    !isRecord(input) ||
    (input.rangeHeader !== null && typeof input.rangeHeader !== 'string') ||
    (input.ifRangeHeader !== null && typeof input.ifRangeHeader !== 'string')
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  validateOperationTime(state, input.now);
  if (!isHolderId(input.holderId)) {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  assertAvailable(state, input.now);

  const current = pruneExpiredLeases(state, input.now);
  if (current.leases.some((lease) => lease.holderId === input.holderId)) {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  if (current.leases.length >= MAX_CONCURRENT_DOWNLOAD_STREAMS) {
    return fail('DOWNLOAD_CONCURRENT_LIMIT');
  }

  const requestedInterval = resolveRequestedInterval(
    current,
    input.rangeHeader,
    input.ifRangeHeader,
  );
  const lease: DownloadStreamLease = {
    holderId: input.holderId,
    sequence: 0,
    acquiredAt: input.now,
    renewedAt: input.now,
    expiresAt: boundedDeadline(input.now, DOWNLOAD_STREAM_LEASE_MS, current.absoluteExpiresAt),
    requestedInterval: requestedInterval === null ? null : cloneInterval(requestedInterval),
  };
  const next: DownloadSessionState = {
    ...current,
    status: 'ACTIVE',
    idleExpiresAt: boundedDeadline(input.now, DOWNLOAD_IDLE_DEADLINE_MS, current.absoluteExpiresAt),
    completionExpiresAt: null,
    lastActivityAt: input.now,
    leases: [...current.leases.map(cloneLease), lease],
  };
  return {
    state: cloneState(next),
    lease: cloneLease(lease),
    request: {
      requestedInterval: requestedInterval === null ? null : cloneInterval(requestedInterval),
      representationPin: representationPin(current.representation),
    },
  };
}

export function renewDownloadStream(
  state: DownloadSessionState,
  input: RenewDownloadStreamInput,
): RenewDownloadStreamResult {
  validateState(state);
  if (!isRecord(input) || typeof input.progress !== 'boolean') {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  validateOperationTime(state, input.now);
  if (!isHolderId(input.holderId) || state.status !== 'ACTIVE') {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  assertAvailable(state, input.now);
  const current = pruneExpiredLeases(state, input.now);
  if (current.status !== 'ACTIVE') {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  const currentLease = findLease(current, input.holderId);
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence <= currentLease.sequence ||
    input.sequence < 0
  ) {
    return fail('DOWNLOAD_SEQUENCE_INVALID');
  }

  const renewed: DownloadStreamLease = {
    ...cloneLease(currentLease),
    sequence: input.sequence,
    renewedAt: input.now,
    expiresAt: boundedDeadline(input.now, DOWNLOAD_STREAM_LEASE_MS, current.absoluteExpiresAt),
  };
  const next: DownloadSessionState = {
    ...cloneState(current),
    idleExpiresAt: input.progress
      ? boundedDeadline(input.now, DOWNLOAD_IDLE_DEADLINE_MS, current.absoluteExpiresAt)
      : current.idleExpiresAt,
    lastActivityAt: input.progress ? input.now : current.lastActivityAt,
    leases: current.leases.map((lease) =>
      lease.holderId === input.holderId ? renewed : cloneLease(lease),
    ),
  };
  return { state: cloneState(next), lease: cloneLease(renewed) };
}

function assertMutableLease(
  state: DownloadSessionState,
  input: InterruptDownloadStreamInput,
): {
  readonly current: DownloadSessionState;
  readonly lease: DownloadStreamLease;
} {
  validateState(state);
  if (!isRecord(input)) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  validateOperationTime(state, input.now);
  if (!isHolderId(input.holderId) || state.status !== 'ACTIVE') {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  assertAvailable(state, input.now);
  const current = pruneExpiredLeases(state, input.now);
  if (current.status !== 'ACTIVE') {
    return fail('DOWNLOAD_LEASE_INVALID');
  }
  const lease = findLease(current, input.holderId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence !== lease.sequence) {
    return fail('DOWNLOAD_SEQUENCE_INVALID');
  }
  return { current, lease };
}

function creditableInterval(
  state: DownloadSessionState,
  lease: DownloadStreamLease,
  input: FinishDownloadStreamInput,
): ByteInterval | null {
  const pin = representationPin(state.representation);
  const upstream: unknown = input.upstream;
  if (
    input.normalEof !== true ||
    !isRecord(upstream) ||
    (upstream['status'] !== 200 && upstream['status'] !== 206) ||
    !isHeaderSource(upstream['headers']) ||
    pin === null
  ) {
    return null;
  }

  let plan;
  try {
    plan = createTransferPlan({
      status: upstream['status'],
      headers: upstream['headers'],
      ...(lease.requestedInterval === null
        ? {}
        : { requested: cloneInterval(lease.requestedInterval) }),
      pin,
    });
  } catch {
    return null;
  }

  if (
    plan.expectedBytes === null ||
    plan.end === null ||
    plan.total === null ||
    plan.validator === null ||
    !plan.completionReliable ||
    input.actualBytes !== plan.expectedBytes ||
    plan.total !== state.representation.total ||
    state.representation.validator === null ||
    !sameValidator(plan.validator, state.representation.validator)
  ) {
    return null;
  }
  return { start: plan.start, end: plan.end, total: plan.total };
}

function stateAfterLeaseEnds(
  state: DownloadSessionState,
  holderId: string,
  now: number,
  progress: boolean,
): Pick<DownloadSessionState, 'idleExpiresAt' | 'lastActivityAt' | 'leases'> {
  return {
    idleExpiresAt: progress
      ? boundedDeadline(now, DOWNLOAD_IDLE_DEADLINE_MS, state.absoluteExpiresAt)
      : state.idleExpiresAt,
    lastActivityAt: progress ? now : state.lastActivityAt,
    leases: state.leases.filter((lease) => lease.holderId !== holderId).map(cloneLease),
  };
}

export function finishDownloadStream(
  state: DownloadSessionState,
  input: FinishDownloadStreamInput,
): DownloadSessionState {
  if (
    !isRecord(input) ||
    typeof input.actualBytes !== 'number' ||
    !Number.isSafeInteger(input.actualBytes) ||
    input.actualBytes < 0
  ) {
    return fail('DOWNLOAD_STATE_INVALID');
  }
  const { current, lease } = assertMutableLease(state, input);
  const ended = stateAfterLeaseEnds(current, input.holderId, input.now, input.actualBytes > 0);
  const interval = creditableInterval(current, lease, input);
  const completedIntervals =
    interval === null
      ? current.completedIntervals.map(cloneInterval)
      : mergeCompletedIntervals(
          [...current.completedIntervals.map(cloneInterval), interval],
          interval.total,
        );
  const completed =
    interval !== null &&
    ended.leases.length === 0 &&
    coversFullRepresentation(completedIntervals, interval.total);
  let status: DownloadState = 'INTERRUPTED';
  if (completed) {
    status = 'COMPLETE_PENDING';
  } else if (ended.leases.length > 0) {
    status = 'ACTIVE';
  }
  const next: DownloadSessionState = {
    ...cloneState(current),
    ...ended,
    status,
    completionExpiresAt: completed
      ? boundedDeadline(input.now, DOWNLOAD_COMPLETION_GRACE_MS, current.absoluteExpiresAt)
      : null,
    completedIntervals,
  };
  return cloneState(next);
}

export function interruptDownloadStream(
  state: DownloadSessionState,
  input: InterruptDownloadStreamInput,
): DownloadSessionState {
  const { current } = assertMutableLease(state, input);
  const ended = stateAfterLeaseEnds(current, input.holderId, input.now, false);
  return cloneState({
    ...cloneState(current),
    ...ended,
    status: ended.leases.length > 0 ? 'ACTIVE' : 'INTERRUPTED',
    completionExpiresAt: null,
  });
}

function expiredDownloadState(state: DownloadSessionState): DownloadSessionState {
  return cloneState({
    ...cloneState(state),
    status: 'EXPIRED',
    completionExpiresAt: null,
    leases: [],
  });
}

function nextDownloadAlarm(state: DownloadSessionState, now: number): number {
  const deadlines = [state.absoluteExpiresAt];
  if (state.status === 'ISSUED') {
    deadlines.push(state.startExpiresAt);
  } else if (state.status === 'COMPLETE_PENDING') {
    if (state.completionExpiresAt !== null) {
      deadlines.push(state.completionExpiresAt);
    }
  } else if (state.status === 'ACTIVE') {
    if (state.idleExpiresAt !== null) {
      deadlines.push(state.idleExpiresAt);
    }
    deadlines.push(...state.leases.map((lease) => lease.expiresAt));
  } else if (state.status === 'INTERRUPTED' && state.idleExpiresAt !== null) {
    deadlines.push(state.idleExpiresAt);
  }
  const alarmAt = Math.min(...deadlines);
  return alarmAt > now ? alarmAt : fail('DOWNLOAD_STATE_INVALID');
}

export function decideDownloadAlarm(
  state: DownloadSessionState,
  now: number,
): DownloadAlarmDecision {
  validateState(state);
  validateOperationTime(state, now);
  if (state.status === 'EXPIRED') {
    return { action: 'delete', state: expiredDownloadState(state) };
  }

  const current = pruneExpiredLeases(state, now);
  if (isLifecycleExpired(current, now)) {
    return { action: 'delete', state: expiredDownloadState(current) };
  }
  return {
    action: 'retain',
    state: cloneState(current),
    alarmAt: nextDownloadAlarm(current, now),
  };
}
