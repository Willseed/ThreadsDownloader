import { describe, expect, it, vi } from 'vitest';

import {
  acquireSessionDownloadAdmission,
  SESSION_DOWNLOAD_ADMISSION_REQUEST_TIMEOUT_MS,
  SessionDownloadAdmissionError,
} from '../src/security/session-download-admission-client.js';
import type { SessionNamespace } from '../src/security/session-client.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

function opaque(length: number, offset: number): string {
  return encodeBase64Url(Uint8Array.from({ length }, (_, index) => (index + offset) % 256));
}

const input = {
  session: {
    rawId: opaque(32, 1),
    sessionHash: opaque(32, 2),
  },
  downloadId: opaque(24, 3),
};
const receivedAt = 10_000;
const clock = (): number => receivedAt;

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly path: string;
}

function namespaceHarness(handle: (request: RecordedRequest) => Promise<Response> | Response): {
  readonly idNames: string[];
  readonly namespace: SessionNamespace;
  readonly requests: RecordedRequest[];
} {
  const idNames: string[] = [];
  const requests: RecordedRequest[] = [];
  const namespace: SessionNamespace = {
    idFromName(name) {
      idNames.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(request) {
          const recorded = {
            path: new URL(request.url).pathname,
            body: (await request.json()) as Record<string, unknown>,
          };
          requests.push(recorded);
          return handle(recorded);
        },
      };
    },
  };
  return { idNames, namespace, requests };
}

function permitResponse(body: Record<string, unknown>, sequence: number): Response {
  return Response.json(
    {
      ok: true,
      permitId: body['permitId'],
      sequence,
      expiresAt: 100_000,
    },
    { status: sequence === 0 ? 201 : 200 },
  );
}

function primitiveJsonResponse(value: unknown, status: number): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('session download admission client', () => {
  it('keeps raw session identity out of wire payloads and serializes capability mutations', async () => {
    const harness = namespaceHarness(({ path, body }) => {
      if (path === '/download-permits/acquire') {
        return permitResponse(body, 0);
      }
      if (path === '/download-permits/renew') {
        return permitResponse(body, body['sequence'] as number);
      }
      return Response.json({ ok: true });
    });

    const admission = await acquireSessionDownloadAdmission(harness.namespace, input, clock);
    await Promise.all([admission.renew(), admission.renew()]);
    const firstRelease = admission.release();
    const secondRelease = admission.release();
    await Promise.all([firstRelease, secondRelease]);

    expect(harness.idNames).toEqual([input.session.rawId]);
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/download-permits/acquire',
      '/download-permits/renew',
      '/download-permits/renew',
      '/download-permits/release',
    ]);
    expect(
      harness.requests
        .filter((request) => request.path === '/download-permits/renew')
        .map((request) => request.body['sequence']),
    ).toEqual([1, 2]);
    expect(harness.requests[0]!.body).toMatchObject({
      sessionHash: input.session.sessionHash,
      downloadId: input.downloadId,
    });
    expect(JSON.stringify(harness.requests)).not.toContain(input.session.rawId);
    await expect(admission.renew()).rejects.toMatchObject({
      code: 'SESSION_DOWNLOAD_UNAVAILABLE',
    });
  });

  it.each([
    [401, 'SESSION_INVALID', 401],
    [429, 'SESSION_DOWNLOAD_LIMIT', 429],
  ])(
    'maps a definite %i denial without sending compensation',
    async (status, code, errorStatus) => {
      const harness = namespaceHarness(() => Response.json({ ok: false }, { status }));

      await expect(
        acquireSessionDownloadAdmission(harness.namespace, input, clock),
      ).rejects.toMatchObject({
        code,
        status: errorStatus,
      });
      expect(harness.requests).toHaveLength(1);
    },
  );

  it('best-effort releases the exact binding after an ambiguous acquire transport failure', async () => {
    const harness = namespaceHarness(({ path }) => {
      if (path === '/download-permits/acquire') {
        throw new Error('transport closed');
      }
      return Response.json({ ok: true });
    });

    await expect(
      acquireSessionDownloadAdmission(harness.namespace, input, clock),
    ).rejects.toBeInstanceOf(SessionDownloadAdmissionError);
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/download-permits/acquire',
      '/download-permits/release',
    ]);
    expect(harness.requests[1]!.body).toEqual(harness.requests[0]!.body);
  });

  it('rejects a malformed success and compensates without accepting a foreign permit', async () => {
    const harness = namespaceHarness(({ path }) =>
      path === '/download-permits/acquire'
        ? Response.json(
            { ok: true, permitId: opaque(24, 9), sequence: 0, expiresAt: 100_000 },
            { status: 201 },
          )
        : Response.json({ ok: true }),
    );

    await expect(
      acquireSessionDownloadAdmission(harness.namespace, input, clock),
    ).rejects.toMatchObject({ code: 'SESSION_DOWNLOAD_UNAVAILABLE' });
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/download-permits/acquire',
      '/download-permits/release',
    ]);
    expect(harness.requests[1]!.body['permitId']).toBe(harness.requests[0]!.body['permitId']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['zero', 0],
    ['false', false],
  ] as const)('rejects %s success bodies on acquire and renew', async (_name, value) => {
    for (const invalidOperation of ['acquire', 'renew'] as const) {
      const harness = namespaceHarness(({ path, body }) => {
        if (path === '/download-permits/acquire') {
          return invalidOperation === 'acquire'
            ? primitiveJsonResponse(value, 201)
            : permitResponse(body, 0);
        }
        if (path === '/download-permits/renew') {
          return primitiveJsonResponse(value, 200);
        }
        return Response.json({ ok: true });
      });

      if (invalidOperation === 'acquire') {
        await expect(
          acquireSessionDownloadAdmission(harness.namespace, input, clock),
        ).rejects.toMatchObject({ code: 'SESSION_DOWNLOAD_UNAVAILABLE' });
        expect(harness.requests.map((request) => request.path)).toEqual([
          '/download-permits/acquire',
          '/download-permits/release',
        ]);
      } else {
        const admission = await acquireSessionDownloadAdmission(harness.namespace, input, clock);
        await expect(admission.renew()).rejects.toMatchObject({
          code: 'SESSION_DOWNLOAD_UNAVAILABLE',
        });
        expect(harness.requests.map((request) => request.path)).toEqual([
          '/download-permits/acquire',
          '/download-permits/renew',
        ]);
      }
    }
  });

  it.each([receivedAt, receivedAt + 44_999, receivedAt + 90_001])(
    'rejects an unbounded server lease deadline %i and compensates',
    async (expiresAt) => {
      const harness = namespaceHarness(({ path, body }) =>
        path === '/download-permits/acquire'
          ? Response.json(
              { ok: true, permitId: body['permitId'], sequence: 0, expiresAt },
              { status: 201 },
            )
          : Response.json({ ok: true }),
      );

      await expect(
        acquireSessionDownloadAdmission(harness.namespace, input, clock),
      ).rejects.toMatchObject({ code: 'SESSION_DOWNLOAD_UNAVAILABLE' });
      expect(harness.requests.map((request) => request.path)).toEqual([
        '/download-permits/acquire',
        '/download-permits/release',
      ]);
    },
  );

  it('sends one best-effort exact release without waiting for an in-flight renewal', async () => {
    let resolveRenewal!: (response: Response) => void;
    const renewal = new Promise<Response>((resolve) => {
      resolveRenewal = resolve;
    });
    const releaseAttempt = vi.fn();
    const harness = namespaceHarness(({ path, body }) => {
      if (path === '/download-permits/acquire') {
        return permitResponse(body, 0);
      }
      if (path === '/download-permits/renew') {
        return renewal;
      }
      releaseAttempt();
      throw new Error('release unavailable');
    });
    const admission = await acquireSessionDownloadAdmission(harness.namespace, input, clock);
    const renewing = admission.renew();
    await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
    const releasing = admission.release();

    await expect(releasing).resolves.toBeUndefined();
    expect(releaseAttempt).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.path)).toEqual([
      '/download-permits/acquire',
      '/download-permits/renew',
      '/download-permits/release',
    ]);
    resolveRenewal(permitResponse(harness.requests[1]!.body, 1));
    await renewing;
    await expect(admission.release()).resolves.toBeUndefined();
    expect(releaseAttempt).toHaveBeenCalledTimes(1);
  });

  it('bounds a never-settling best-effort release and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const harness = namespaceHarness(({ path, body }) => {
        if (path === '/download-permits/acquire') {
          return permitResponse(body, 0);
        }
        return new Promise<Response>(() => undefined);
      });
      const admission = await acquireSessionDownloadAdmission(harness.namespace, input, clock);
      const releasing = admission.release();
      let settled = false;
      void releasing.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(SESSION_DOWNLOAD_ADMISSION_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(releasing).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
