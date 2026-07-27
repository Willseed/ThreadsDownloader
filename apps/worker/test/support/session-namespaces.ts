import type { SessionNamespace } from '../../src/security/session-client.js';
import type { SessionIssuanceRateLimitNamespace } from '../../src/security/session-issuance.js';

interface FakeSessionRecord {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface FakeSessionNamespace extends SessionNamespace {
  delete(rawId: string): void;
}

export type SessionWorkflowEvent =
  | 'issuance:commit'
  | 'issuance:release'
  | 'issuance:reserve'
  | 'session:authorize'
  | 'session:create'
  | 'session:resume';

export interface FakeSessionNamespaceOptions {
  readonly createdExpiryOffset?: number;
  readonly requests?: unknown[];
  readonly responseStatus?: number;
  readonly trace?: SessionWorkflowEvent[];
}

export function createSessionNamespace(
  options: FakeSessionNamespaceOptions = {},
): FakeSessionNamespace {
  const { createdExpiryOffset = 0, requests = [], responseStatus = 200, trace } = options;
  const ids = new Map<DurableObjectId, string>();
  const records = new Map<string, FakeSessionRecord>();
  return {
    delete(rawId) {
      records.delete(rawId);
    },
    idFromName(name: string) {
      const id = {} as DurableObjectId;
      ids.set(id, name);
      return id;
    },
    get(id) {
      const name = ids.get(id)!;
      return {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          expectRequest(pathname, request.method);
          recordSessionEvent(trace, pathname);
          const body: unknown = await request.json();
          requests.push(body);
          if (responseStatus !== 200) {
            return Response.json({ ok: false }, { status: responseStatus });
          }
          if (pathname === '/authorize') {
            return Response.json({ ok: true });
          }
          const input = body as FakeSessionRecord;
          const current = records.get(name);
          if (pathname === '/resume') {
            if (current === undefined || current.sessionHash !== input.sessionHash) {
              return Response.json({ ok: false }, { status: 410 });
            }
            records.set(name, { ...current, csrfHash: input.csrfHash });
            return Response.json({ ok: true, expiresAt: current.expiresAt });
          }
          if (current !== undefined) {
            return Response.json({ ok: false }, { status: 409 });
          }
          records.set(name, input);
          return Response.json({ ok: true, expiresAt: input.expiresAt + createdExpiryOffset });
        },
      };
    },
  };
}

function recordSessionEvent(trace: SessionWorkflowEvent[] | undefined, pathname: string): void {
  if (trace === undefined) {
    return;
  }
  if (pathname === '/authorize') {
    trace.push('session:authorize');
  } else if (pathname === '/create') {
    trace.push('session:create');
  } else {
    trace.push('session:resume');
  }
}

function expectRequest(pathname: string, method: string): void {
  if (method !== 'POST' || !['/authorize', '/create', '/resume'].includes(pathname)) {
    throw new Error(`Unexpected fake SessionCoordinator request: ${method} ${pathname}`);
  }
}

export function createLostSessionNamespace(
  options: Pick<FakeSessionNamespaceOptions, 'trace'> = {},
): FakeSessionNamespace {
  return {
    delete: () => undefined,
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        expectRequest(pathname, request.method);
        recordSessionEvent(options.trace, pathname);
        throw new Error('session response lost');
      },
    }),
  };
}

export interface FakeIpRateLimitNamespace extends SessionIssuanceRateLimitNamespace {
  readonly requests: Request[];
}

export interface FakeIpRateLimitNamespaceOptions {
  readonly handler?: (request: Request) => Promise<Response>;
  readonly trace?: SessionWorkflowEvent[];
}

export function createIpRateLimitNamespace(
  options: FakeIpRateLimitNamespaceOptions = {},
): FakeIpRateLimitNamespace {
  const requests: Request[] = [];
  return {
    requests,
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(request: Request) {
          requests.push(request.clone() as unknown as Request);
          const pathname = new URL(request.url).pathname;
          recordIssuanceEvent(options.trace, pathname);
          if (options.handler !== undefined) {
            return options.handler(request);
          }
          const body = (await request.json()) as {
            readonly now: number;
            readonly reservationId: string;
          };
          return pathname === '/session-issuance/reserve'
            ? Response.json(
                {
                  ok: true,
                  reservationId: body.reservationId,
                  expiresAt: body.now + 30_000,
                },
                { status: 201 },
              )
            : Response.json({ ok: true });
        },
      };
    },
  };
}

function recordIssuanceEvent(trace: SessionWorkflowEvent[] | undefined, pathname: string): void {
  if (trace === undefined) {
    return;
  }
  if (pathname === '/session-issuance/reserve') {
    trace.push('issuance:reserve');
  } else if (pathname === '/session-issuance/commit') {
    trace.push('issuance:commit');
  } else if (pathname === '/session-issuance/release') {
    trace.push('issuance:release');
  }
}

export function issuancePaths(namespace: FakeIpRateLimitNamespace): string[] {
  return namespace.requests.map((request) => new URL(request.url).pathname);
}
