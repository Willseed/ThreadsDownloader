import { describe, expect, it } from 'vitest';

import { authorizeSession } from '../src/security/session-client.js';
import { createSessionNamespace } from './support/session-namespaces.js';

describe('session client', () => {
  it('authorizes through a hash-only internal request and safely handles failures', async () => {
    const requests: unknown[] = [];
    await expect(
      authorizeSession(
        createSessionNamespace({ requests }),
        'internal-id',
        'A'.repeat(43),
        'B'.repeat(43),
        100,
      ),
    ).resolves.toBe(true);
    expect(requests[0]).toEqual({
      sessionHash: 'A'.repeat(43),
      csrfHash: 'B'.repeat(43),
      now: 100,
    });
    await expect(
      authorizeSession(
        createSessionNamespace({ responseStatus: 500 }),
        'internal-id',
        'A'.repeat(43),
        'B'.repeat(43),
      ),
    ).resolves.toBe(false);
  });
});
