import { describe, expect, it } from 'vitest';

import {
  createSessionCoordinatorRequest,
  SESSION_COORDINATOR_METHOD,
  SESSION_COORDINATOR_ROUTES,
} from '../src/session-coordinator-protocol.js';

describe('session coordinator protocol', () => {
  it('groups the exact routes and preserves the internal JSON request wire shape', async () => {
    expect(SESSION_COORDINATOR_ROUTES).toEqual({
      session: {
        create: '/create',
        resume: '/resume',
        authorize: '/authorize',
      },
      resolvePermits: {
        acquire: '/resolve-permits/acquire',
        release: '/resolve-permits/release',
      },
      downloadPermits: {
        acquire: '/download-permits/acquire',
        renew: '/download-permits/renew',
        release: '/download-permits/release',
      },
      resolveVault: {
        store: '/resolve-vault/store',
        claim: '/resolve-vault/claim',
        settle: '/resolve-vault/settle',
      },
    });

    const body = { second: 2, first: 1 };
    const request = createSessionCoordinatorRequest('/resolve-vault/store', body);

    expect(SESSION_COORDINATOR_METHOD).toBe('POST');
    expect(request.url).toBe('https://session.internal/resolve-vault/store');
    expect(request.method).toBe('POST');
    expect([...request.headers.entries()]).toEqual([['content-type', 'application/json']]);
    await expect(request.text()).resolves.toBe('{"second":2,"first":1}');
  });
});
