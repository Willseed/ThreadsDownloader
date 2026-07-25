import { describe, expect, it } from 'vitest';

import type { BrowserSessionIdentity, SessionNamespace } from '../src/index.js';
import { importSigningKey } from '../src/security/cryptography.js';
import { acquireResolveLimits, type IpRateLimitNamespace } from '../src/security/resolve-limits.js';
import { decodeBase64Url } from '../src/utils/base64url.js';

const signingKeyMaterial = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const identity: BrowserSessionIdentity = {
  rawId: 'raw-session-routing-id',
  sessionHash: 'S'.repeat(43),
};
const csrfHash = 'C'.repeat(43);
const now = 10_000;

interface HarnessOptions {
  readonly ipAcquireBody?: unknown;
  readonly ipAcquireStatus?: number;
  readonly ipMalformedJson?: boolean;
  readonly ipThrows?: boolean;
  readonly releaseThrows?: boolean;
  readonly sessionAcquireBody?: unknown;
  readonly sessionAcquireStatus?: number;
}

interface Harness {
  readonly ipBodies: unknown[];
  readonly ipNames: string[];
  readonly ipRateLimits: IpRateLimitNamespace;
  readonly sequence: string[];
  readonly sessionBodies: unknown[];
  readonly sessions: SessionNamespace;
}

function harness(options: HarnessOptions = {}): Harness {
  const sequence: string[] = [];
  const sessionBodies: unknown[] = [];
  const ipBodies: unknown[] = [];
  const ipNames: string[] = [];
  const sessionIds = new Map<DurableObjectId, string>();
  const ipIds = new Map<DurableObjectId, string>();
  const sessions: SessionNamespace = {
    idFromName(name) {
      const id = {} as DurableObjectId;
      sessionIds.set(id, name);
      return id;
    },
    get(id) {
      expect(sessionIds.get(id)).toBe(identity.rawId);
      return {
        async fetch(request) {
          const release = new URL(request.url).pathname.endsWith('/release');
          sequence.push(`session:${release ? 'release' : 'acquire'}`);
          const body: unknown = await request.json();
          sessionBodies.push(body);
          if (release && options.releaseThrows === true) {
            throw new Error('private session release failure');
          }
          if (release) {
            return Response.json({ ok: true });
          }
          const status = options.sessionAcquireStatus ?? 201;
          return Response.json(
            options.sessionAcquireBody ??
              (status === 201 ? { ok: true, expiresAt: now + 30_000 } : { ok: false }),
            { status },
          );
        },
      };
    },
  };
  const ipRateLimits: IpRateLimitNamespace = {
    idFromName(name) {
      const id = {} as DurableObjectId;
      ipIds.set(id, name);
      ipNames.push(name);
      return id;
    },
    get(id) {
      const routedHash = ipIds.get(id)!;
      return {
        async fetch(request) {
          const release = new URL(request.url).pathname === '/release';
          sequence.push(`ip:${release ? 'release' : 'acquire'}`);
          const body: unknown = await request.json();
          ipBodies.push(body);
          expect((body as Record<string, unknown>)['ipHash']).toBe(routedHash);
          if (options.ipThrows === true || (release && options.releaseThrows === true)) {
            throw new Error('private IP limiter failure');
          }
          if (release) {
            return Response.json({ ok: true });
          }
          const status = options.ipAcquireStatus ?? 201;
          if (options.ipMalformedJson === true) {
            return new Response('{malformed private response', { status });
          }
          return Response.json(
            options.ipAcquireBody ??
              (status === 201 ? { ok: true, expiresAt: now + 20_000 } : { ok: false }),
            { status },
          );
        },
      };
    },
  };
  return { ipBodies, ipNames, ipRateLimits, sequence, sessionBodies, sessions };
}

async function acquire(
  subject: Harness,
  headers = new Headers({ 'CF-Connecting-IP': '203.0.113.42' }),
) {
  return acquireResolveLimits({
    sessions: subject.sessions,
    ipRateLimits: subject.ipRateLimits,
    signingKey: await importSigningKey(signingKeyMaterial),
    identity,
    csrfHash,
    headers,
    now,
  });
}

describe('resolve limit acquisition saga', () => {
  it('acquires session then keyed-IP capacity and releases both exactly once', async () => {
    const subject = harness();
    const lease = await acquire(subject);

    expect(subject.sequence).toEqual(['session:acquire', 'ip:acquire']);
    expect(decodeBase64Url(lease.permitId).byteLength).toBeGreaterThanOrEqual(16);
    expect(lease.expiresAt).toBe(now + 20_000);
    expect(subject.ipNames[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(subject.ipNames[0]).not.toBe('203.0.113.42');
    expect(subject.ipBodies[0]).toMatchObject({
      ipHash: subject.ipNames[0],
      permitId: lease.permitId,
      now,
    });
    expect(Object.keys(subject.ipBodies[0] as Record<string, unknown>).sort()).toEqual([
      'ipHash',
      'now',
      'permitId',
    ]);
    expect(JSON.stringify(subject.ipBodies)).not.toContain('203.0.113.42');
    expect(JSON.stringify(subject.sessionBodies)).not.toContain(identity.rawId);

    await expect(lease.release()).resolves.toBeUndefined();
    await expect(lease.release()).resolves.toBeUndefined();
    expect(subject.sequence).toEqual([
      'session:acquire',
      'ip:acquire',
      'session:release',
      'ip:release',
    ]);
  });

  it('stops before hashing or IP acquisition when the session denies', async () => {
    const subject = harness({ sessionAcquireStatus: 429 });
    await expect(acquire(subject)).rejects.toMatchObject({ code: 'SESSION_RATE_LIMITED' });
    expect(subject.sequence).toEqual(['session:acquire']);
    expect(subject.ipBodies).toEqual([]);

    const unavailable = harness({ sessionAcquireStatus: 503 });
    await expect(acquire(unavailable)).rejects.toMatchObject({
      code: 'RESOLVE_LIMITS_UNAVAILABLE',
    });
    expect(unavailable.sequence).toEqual(['session:acquire']);
  });

  it('short-circuits an invalid session without touching the IP limiter or release', async () => {
    const privateDetail = 'private durable-object detail';
    const subject = harness({
      sessionAcquireBody: { detail: privateDetail, ok: false },
      sessionAcquireStatus: 401,
    });

    let caught: unknown;
    try {
      await acquire(subject);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'SESSION_INVALID',
      message: 'SESSION_INVALID',
      name: 'ResolveLimitsError',
    });
    expect(JSON.parse(JSON.stringify(caught))).toEqual({
      code: 'SESSION_INVALID',
      name: 'ResolveLimitsError',
    });
    expect(String(caught)).not.toContain(privateDetail);
    expect(String(caught)).not.toContain(identity.rawId);
    expect(subject.sequence).toEqual(['session:acquire']);
    expect(subject.ipNames).toEqual([]);
    expect(subject.ipBodies).toEqual([]);
  });

  it('rolls back the session while preserving an IP denial', async () => {
    const subject = harness({ ipAcquireStatus: 429 });
    await expect(acquire(subject)).rejects.toMatchObject({ code: 'IP_RATE_LIMITED' });
    expect(subject.sequence).toEqual(['session:acquire', 'ip:acquire', 'session:release']);
  });

  it('rolls back the session after invalid IP input or an unavailable IP limiter', async () => {
    const missingIp = harness();
    await expect(
      acquire(missingIp, new Headers({ 'x-forwarded-for': '203.0.113.42' })),
    ).rejects.toMatchObject({ code: 'RESOLVE_CLIENT_IP_INVALID' });
    expect(missingIp.sequence).toEqual(['session:acquire', 'session:release']);

    const unavailable = harness({ ipThrows: true });
    await expect(acquire(unavailable)).rejects.toMatchObject({
      code: 'RESOLVE_LIMITS_UNAVAILABLE',
    });
    expect(unavailable.sequence).toEqual(['session:acquire', 'ip:acquire', 'session:release']);

    const unavailableStatus = harness({ ipAcquireStatus: 503 });
    await expect(acquire(unavailableStatus)).rejects.toMatchObject({
      code: 'RESOLVE_LIMITS_UNAVAILABLE',
    });
  });

  it('fails closed and rolls back when the IP cannot be keyed', async () => {
    const subject = harness();
    await expect(
      acquireResolveLimits({
        sessions: subject.sessions,
        ipRateLimits: subject.ipRateLimits,
        signingKey: {} as CryptoKey,
        identity,
        csrfHash,
        headers: new Headers({ 'CF-Connecting-IP': '203.0.113.42' }),
        now,
      }),
    ).rejects.toMatchObject({ code: 'RESOLVE_LIMITS_UNAVAILABLE' });
    expect(subject.sequence).toEqual(['session:acquire', 'session:release']);
  });

  it('fails closed on malformed success responses and hides release failures', async () => {
    const malformed = harness({ ipAcquireBody: { ok: true, expiresAt: 'private' } });
    await expect(acquire(malformed)).rejects.toMatchObject({
      code: 'RESOLVE_LIMITS_UNAVAILABLE',
    });
    expect(malformed.sequence.at(-1)).toBe('session:release');

    const invalidJson = harness({ ipMalformedJson: true });
    await expect(acquire(invalidJson)).rejects.toMatchObject({
      code: 'RESOLVE_LIMITS_UNAVAILABLE',
    });

    const releaseFailure = harness({ releaseThrows: true });
    const lease = await acquire(releaseFailure);
    await expect(lease.release()).resolves.toBeUndefined();
  });
});
