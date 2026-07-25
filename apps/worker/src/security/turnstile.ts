import { hashIdentifier } from './cryptography.js';

const siteverifyEndpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const maxTokenLength = 2048;
const responseLimitBytes = 16_384;
const verificationTimeoutMs = 8_000;
const maximumChallengeAgeMs = 300_000;
const maximumFutureSkewMs = 30_000;
const replayLifetimeMs = 300_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

export type TurnstileErrorCode =
  'TURNSTILE_INVALID' | 'TURNSTILE_REJECTED' | 'TURNSTILE_REPLAYED' | 'TURNSTILE_UNAVAILABLE';

export class TurnstileError extends Error {
  constructor(readonly code: TurnstileErrorCode) {
    super(code);
    this.name = 'TurnstileError';
  }
}

export interface TurnstileCommand {
  readonly token: string;
  readonly remoteIp?: string;
  readonly idempotencyKey?: string;
}

export interface TurnstileVerification {
  readonly challengeTimestamp: number;
}

export interface TurnstileVerifier {
  verify(command: TurnstileCommand): Promise<TurnstileVerification>;
}

export interface ReplayStub {
  fetch(request: Request): Promise<Response>;
}

export interface TurnstileReplayNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): ReplayStub;
}

export interface TurnstileVerifierOptions {
  readonly secret: string;
  readonly expectedHostname: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

export interface TurnstileOnceDependencies extends TurnstileVerifierOptions {
  readonly replays: TurnstileReplayNamespace;
}

function fail(code: TurnstileErrorCode): never {
  throw new TurnstileError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (response.body === null) {
    return fail('TURNSTILE_UNAVAILABLE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > responseLimitBytes) {
        await reader.cancel().catch(() => undefined);
        return fail('TURNSTILE_UNAVAILABLE');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes)) as unknown;
    return parsed;
  } catch {
    return fail('TURNSTILE_UNAVAILABLE');
  }
}

function decodeSuccess(value: unknown): {
  readonly hostname: string;
  readonly action: string;
  readonly challengeTimestamp: number;
} | null {
  if (!isPlainObject(value) || value['success'] !== true) {
    return null;
  }
  if (
    typeof value['hostname'] !== 'string' ||
    typeof value['action'] !== 'string' ||
    typeof value['challenge_ts'] !== 'string'
  ) {
    return null;
  }
  const challengeTimestamp = Date.parse(value['challenge_ts']);
  return Number.isFinite(challengeTimestamp)
    ? { hostname: value['hostname'], action: value['action'], challengeTimestamp }
    : null;
}

function validateToken(token: string): void {
  if (token.trim() === '' || token.length > maxTokenLength) {
    fail('TURNSTILE_INVALID');
  }
}

export function createTurnstileVerifier(options: TurnstileVerifierOptions): TurnstileVerifier {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async verify(command): Promise<TurnstileVerification> {
      validateToken(command.token);
      const form = new FormData();
      form.set('secret', options.secret);
      form.set('response', command.token);
      if (command.remoteIp !== undefined) {
        form.set('remoteip', command.remoteIp);
      }
      if (command.idempotencyKey !== undefined) {
        form.set('idempotency_key', command.idempotencyKey);
      }

      let response: Response;
      try {
        response = await fetcher(siteverifyEndpoint, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(verificationTimeoutMs),
        });
      } catch {
        return fail('TURNSTILE_UNAVAILABLE');
      }
      if (!response.ok) {
        return fail('TURNSTILE_UNAVAILABLE');
      }
      const decoded = decodeSuccess(await readBoundedResponse(response));
      if (decoded === null) {
        return fail('TURNSTILE_REJECTED');
      }
      const age = now() - decoded.challengeTimestamp;
      if (
        decoded.hostname !== options.expectedHostname ||
        decoded.action !== 'resolve' ||
        age > maximumChallengeAgeMs ||
        age < -maximumFutureSkewMs
      ) {
        return fail('TURNSTILE_REJECTED');
      }
      return { challengeTimestamp: decoded.challengeTimestamp };
    },
  };
}

async function reserveToken(
  replays: TurnstileReplayNamespace,
  tokenHash: string,
  now: number,
): Promise<void> {
  let response: Response;
  try {
    const stub = replays.get(replays.idFromName(tokenHash));
    response = await stub.fetch(
      new Request('https://turnstile-replay.internal/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenHash, consumedAt: now, expiresAt: now + replayLifetimeMs }),
      }),
    );
  } catch {
    return fail('TURNSTILE_UNAVAILABLE');
  }
  if (response.status === 409) {
    return fail('TURNSTILE_REPLAYED');
  }
  if (response.status !== 201) {
    return fail('TURNSTILE_UNAVAILABLE');
  }
}

export async function verifyTurnstileOnce(
  command: TurnstileCommand,
  dependencies: TurnstileOnceDependencies,
): Promise<TurnstileVerification> {
  validateToken(command.token);
  const now = (dependencies.now ?? Date.now)();
  let tokenHash: string;
  try {
    tokenHash = await hashIdentifier(command.token);
  } catch {
    return fail('TURNSTILE_UNAVAILABLE');
  }
  await reserveToken(dependencies.replays, tokenHash, now);
  return createTurnstileVerifier(dependencies).verify(command);
}
