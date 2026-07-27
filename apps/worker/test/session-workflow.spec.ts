import { describe, expect, it, vi } from 'vitest';

import { SESSION_TTL_SECONDS } from '../src/security/browser-session.js';
import {
  createSessionWorkflowHandler,
  type SessionWorkflowBindings,
  type SessionWorkflowRuntime,
} from '../src/workflows/session.js';
import {
  createIpRateLimitNamespace,
  createLostSessionNamespace,
  createSessionNamespace,
  issuancePaths,
  type FakeIpRateLimitNamespace,
  type SessionWorkflowEvent,
} from './support/session-namespaces.js';

const NOW = Date.parse('2026-07-28T00:00:00.000Z');
const REQUEST_ID = 'A'.repeat(32);
const SIGNING_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const TURNSTILE_SITE_KEY = 'test-site-key';

const runtime: SessionWorkflowRuntime = {
  now: () => NOW,
  requestId: () => REQUEST_ID,
};

const handleSession = createSessionWorkflowHandler(runtime);

function createBindings(
  sessions: SessionWorkflowBindings['SESSIONS'] = createSessionNamespace(),
  ipRateLimits: FakeIpRateLimitNamespace = createIpRateLimitNamespace(),
  signingKey = SIGNING_KEY,
): SessionWorkflowBindings {
  return {
    IP_RATE_LIMITS: ipRateLimits,
    SESSION_SIGNING_KEY: signingKey,
    SESSIONS: sessions,
    TURNSTILE_SITE_KEY,
  };
}

function sessionRequest(cookie: string | null = null, clientIp: string | null = '203.0.113.42') {
  const headers = new Headers();
  if (cookie !== null) {
    headers.set('cookie', cookie);
  }
  if (clientIp !== null) {
    headers.set('CF-Connecting-IP', clientIp);
  }
  return new Request('https://threads.example.test/api/session', { headers });
}

function cookiePair(response: Response): string {
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

async function successfulReservationResponse(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    readonly now: number;
    readonly reservationId: string;
  };
  return Response.json(
    {
      ok: true,
      reservationId: body.reservationId,
      expiresAt: body.now + 30_000,
    },
    { status: 201 },
  );
}

describe('session workflow', () => {
  it('reserves, creates, commits, and returns only the public session projection', async () => {
    const trace: SessionWorkflowEvent[] = [];
    const sessionRequests: unknown[] = [];
    const ipRateLimits = createIpRateLimitNamespace({ trace });
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ requests: sessionRequests, trace }), ipRateLimits),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-td_session=');
    expect(body).toEqual({
      csrfToken: expect.any(String),
      expiresAt: new Date(NOW + SESSION_TTL_SECONDS * 1000).toISOString(),
      turnstileSiteKey: TURNSTILE_SITE_KEY,
    });
    expect(sessionRequests).toHaveLength(1);
    expect(sessionRequests[0]).toEqual({
      sessionHash: expect.any(String),
      csrfHash: expect.any(String),
      issuedAt: NOW,
      expiresAt: NOW + SESSION_TTL_SECONDS * 1000,
    });
    expect(trace).toEqual(['issuance:reserve', 'session:create', 'issuance:commit']);
  });

  it('imports the signing key before reading the clock or touching either DO', async () => {
    const now = vi.fn(() => NOW);
    const requestId = vi.fn(() => REQUEST_ID);
    const sessionRequests: unknown[] = [];
    const ipRateLimits = createIpRateLimitNamespace();
    const response = await createSessionWorkflowHandler({ now, requestId })(
      sessionRequest(),
      createBindings(
        createSessionNamespace({ requests: sessionRequests }),
        ipRateLimits,
        'invalid-key-material',
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SESSION_UNAVAILABLE',
        message: '工作階段暫時無法使用，請稍後再試。',
        requestId: REQUEST_ID,
      },
    });
    expect(now).not.toHaveBeenCalled();
    expect(requestId).toHaveBeenCalledOnce();
    expect(sessionRequests).toHaveLength(0);
    expect(ipRateLimits.requests).toHaveLength(0);
  });

  it.each([null, 'invalid client ip'])(
    'fails closed before session allocation for CF IP %s',
    async (clientIp) => {
      const sessionRequests: unknown[] = [];
      const ipRateLimits = createIpRateLimitNamespace();
      const response = await handleSession(
        sessionRequest(null, clientIp),
        createBindings(createSessionNamespace({ requests: sessionRequests }), ipRateLimits),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('retry-after')).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SESSION_UNAVAILABLE', requestId: REQUEST_ID },
      });
      expect(sessionRequests).toHaveLength(0);
      expect(ipRateLimits.requests).toHaveLength(0);
    },
  );

  it('returns a secret-free 429 with the limiter retry deadline and no session side effect', async () => {
    const sessionRequests: unknown[] = [];
    const ipRateLimits = createIpRateLimitNamespace({
      async handler(request) {
        const input = (await request.json()) as { readonly now: number };
        return Response.json({ ok: false, retryAt: input.now + 120_001 }, { status: 429 });
      },
    });
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ requests: sessionRequests }), ipRateLimits),
    );
    const text = await response.text();

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('121');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(text).toContain(`"requestId":"${REQUEST_ID}"`);
    expect(text).toContain('RATE_LIMITED');
    expect(text).not.toContain('203.0.113.42');
    expect(text).not.toContain('ipHash');
    expect(text).not.toContain('count');
    expect(sessionRequests).toHaveLength(0);
  });

  it('returns a secret-free 503 when the issuance limiter fails without allocating a session', async () => {
    const sessionRequests: unknown[] = [];
    const ipRateLimits = createIpRateLimitNamespace({
      handler: async () => {
        throw new Error('private limiter failure');
      },
    });
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ requests: sessionRequests }), ipRateLimits),
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(text).toContain('SESSION_UNAVAILABLE');
    expect(text).not.toContain('private limiter failure');
    expect(text).not.toContain('203.0.113.42');
    expect(sessionRequests).toHaveLength(0);
  });

  it('keeps SESSION_UNAVAILABLE when conflict reservation release transport fails', async () => {
    const trace: SessionWorkflowEvent[] = [];
    const ipRateLimits = createIpRateLimitNamespace({
      async handler(request) {
        if (new URL(request.url).pathname === '/session-issuance/release') {
          throw new Error('release response lost');
        }
        return successfulReservationResponse(request);
      },
      trace,
    });
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ responseStatus: 409, trace }), ipRateLimits),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_UNAVAILABLE' },
    });
    expect(trace).toEqual(['issuance:reserve', 'session:create', 'issuance:release']);
  });

  it('retains the reservation for known and ambiguous non-conflict create failures', async () => {
    const failures: SessionWorkflowBindings['SESSIONS'][] = [
      createSessionNamespace({ responseStatus: 500 }),
      createLostSessionNamespace(),
    ];

    for (const sessions of failures) {
      const ipRateLimits = createIpRateLimitNamespace();
      const response = await handleSession(
        sessionRequest(),
        createBindings(sessions, ipRateLimits),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(issuancePaths(ipRateLimits)).toEqual(['/session-issuance/reserve']);
    }
  });

  it('retains the reservation and withholds the cookie on an expiry mismatch', async () => {
    const ipRateLimits = createIpRateLimitNamespace();
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ createdExpiryOffset: 1 }), ipRateLimits),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(issuancePaths(ipRateLimits)).toEqual(['/session-issuance/reserve']);
  });

  it('retains a committed-or-unknown reservation and withholds the cookie when commit fails', async () => {
    const ipRateLimits = createIpRateLimitNamespace({
      async handler(request) {
        if (new URL(request.url).pathname !== '/session-issuance/reserve') {
          throw new Error('commit response lost');
        }
        return successfulReservationResponse(request);
      },
    });
    const response = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace(), ipRateLimits),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(issuancePaths(ipRateLimits)).toEqual([
      '/session-issuance/reserve',
      '/session-issuance/commit',
    ]);
  });

  it('reuses a valid cookie while rotating CSRF without resetting the cookie', async () => {
    const sessions = createSessionNamespace();
    const ipRateLimits = createIpRateLimitNamespace();
    const bindings = createBindings(sessions, ipRateLimits);
    const first = await handleSession(sessionRequest(), bindings);
    const firstBody = (await first.json()) as { csrfToken: string; expiresAt: string };

    const next = await handleSession(sessionRequest(cookiePair(first), null), bindings);
    const nextBody = (await next.json()) as { csrfToken: string; expiresAt: string };

    expect(next.status).toBe(200);
    expect(next.headers.get('set-cookie')).toBeNull();
    expect(nextBody.csrfToken).not.toBe(firstBody.csrfToken);
    expect(nextBody.expiresAt).toBe(firstBody.expiresAt);
    expect(ipRateLimits.requests).toHaveLength(2);
  });

  it('charges and replaces a signed cookie whose SessionCoordinator record is gone', async () => {
    const sessions = createSessionNamespace();
    const ipRateLimits = createIpRateLimitNamespace();
    const bindings = createBindings(sessions, ipRateLimits);
    const first = await handleSession(sessionRequest(), bindings);
    const signedCookie = cookiePair(first).split('=', 2)[1]!;
    const rawId = signedCookie.split('.', 1)[0]!;
    sessions.delete(rawId);

    const replacement = await handleSession(
      sessionRequest(`__Host-td_session=${signedCookie}`),
      bindings,
    );

    expect(replacement.status).toBe(200);
    expect(replacement.headers.get('set-cookie')).toContain('__Host-td_session=');
    expect(replacement.headers.get('set-cookie')).not.toContain(signedCookie);
    expect(ipRateLimits.requests).toHaveLength(4);
  });

  it('replaces a tampered cookie but safely projects an internal session denial', async () => {
    const replacement = await handleSession(
      sessionRequest('__Host-td_session=tampered.secret'),
      createBindings(),
    );
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get('set-cookie')).toContain('__Host-td_session=');

    const denied = await handleSession(
      sessionRequest(),
      createBindings(createSessionNamespace({ responseStatus: 401 })),
    );
    const body = await denied.text();
    expect(denied.status).toBe(503);
    expect(body).toContain('SESSION_UNAVAILABLE');
    expect(body).not.toContain('sessionHash');
  });
});
