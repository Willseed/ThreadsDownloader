import { describe, expect, it } from 'vitest';

import {
  acquireSessionDownloadPermit,
  MAX_CONCURRENT_SESSION_DOWNLOADS,
  nextSessionDownloadPermitDeadline,
  releaseSessionDownloadPermit,
  renewSessionDownloadPermit,
  SESSION_DOWNLOAD_PERMIT_LEASE_MS,
  SessionDownloadAdmissionStateError,
  type SessionDownloadAdmissionState,
} from '../src/security/session-download-admission.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

function opaque24(offset: number): string {
  return encodeBase64Url(Uint8Array.from({ length: 24 }, (_, index) => (index + offset) % 256));
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SessionDownloadAdmissionStateError);
    return (error as SessionDownloadAdmissionStateError).code;
  }
}

const empty: SessionDownloadAdmissionState = { permits: [] };
const downloadId = opaque24(100);

describe('session download admission state', () => {
  it('admits four live connections and reclaims an expired slot for the fifth', () => {
    let state = empty;
    for (let index = 0; index < MAX_CONCURRENT_SESSION_DOWNLOADS; index += 1) {
      state = acquireSessionDownloadPermit(state, {
        now: 1_000,
        sessionExpiresAt: 1_000_000,
        permitId: opaque24(index + 1),
        downloadId,
      }).state;
    }

    expect(
      errorCode(() =>
        acquireSessionDownloadPermit(state, {
          now: 2_000,
          sessionExpiresAt: 1_000_000,
          permitId: opaque24(10),
          downloadId,
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_LIMIT');

    const admitted = acquireSessionDownloadPermit(state, {
      now: 1_000 + SESSION_DOWNLOAD_PERMIT_LEASE_MS,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(10),
      downloadId,
    });
    expect(admitted.state.permits).toHaveLength(1);
    expect(admitted.permit.permitId).toBe(opaque24(10));
  });

  it('makes acquire idempotent only for the exact permit binding', () => {
    const first = acquireSessionDownloadPermit(empty, {
      now: 1_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
    });
    const replay = acquireSessionDownloadPermit(first.state, {
      now: 2_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
    });

    expect(replay).toEqual(first);
    expect(
      errorCode(() =>
        acquireSessionDownloadPermit(first.state, {
          now: 2_000,
          sessionExpiresAt: 1_000_000,
          permitId: opaque24(1),
          downloadId: opaque24(101),
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_CONFLICT');
  });

  it('renews exactly the next sequence and treats the last acknowledgement as idempotent', () => {
    const acquired = acquireSessionDownloadPermit(empty, {
      now: 1_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
    });
    const renewed = renewSessionDownloadPermit(acquired.state, {
      now: 30_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
      sequence: 1,
    });
    const replay = renewSessionDownloadPermit(renewed.state, {
      now: 35_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
      sequence: 1,
    });

    expect(replay).toEqual(renewed);
    expect(renewed.permit.expiresAt).toBe(30_000 + SESSION_DOWNLOAD_PERMIT_LEASE_MS);
    expect(
      errorCode(() =>
        renewSessionDownloadPermit(renewed.state, {
          now: 35_000,
          sessionExpiresAt: 1_000_000,
          permitId: opaque24(1),
          downloadId,
          sequence: 3,
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_CONFLICT');
  });

  it('bounds a lease by the session lifetime and rejects renewal at expiry', () => {
    const acquired = acquireSessionDownloadPermit(empty, {
      now: 1_000,
      sessionExpiresAt: 50_000,
      permitId: opaque24(1),
      downloadId,
    });

    expect(acquired.permit.expiresAt).toBe(50_000);
    expect(
      errorCode(() =>
        acquireSessionDownloadPermit(empty, {
          now: 6_000,
          sessionExpiresAt: 50_000,
          permitId: opaque24(2),
          downloadId,
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_INVALID');
    expect(
      errorCode(() =>
        renewSessionDownloadPermit(acquired.state, {
          now: 50_000,
          sessionExpiresAt: 50_000,
          permitId: opaque24(1),
          downloadId,
          sequence: 1,
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_INVALID');
  });

  it('releases only an exact live binding and reports the earliest alarm deadline', () => {
    const first = acquireSessionDownloadPermit(empty, {
      now: 1_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(1),
      downloadId,
    });
    const second = acquireSessionDownloadPermit(first.state, {
      now: 2_000,
      sessionExpiresAt: 1_000_000,
      permitId: opaque24(2),
      downloadId: opaque24(101),
    });

    expect(nextSessionDownloadPermitDeadline(second.state)).toBe(
      1_000 + SESSION_DOWNLOAD_PERMIT_LEASE_MS,
    );
    expect(
      errorCode(() =>
        releaseSessionDownloadPermit(second.state, {
          now: 3_000,
          permitId: opaque24(1),
          downloadId: opaque24(101),
        }),
      ),
    ).toBe('SESSION_DOWNLOAD_CONFLICT');

    const released = releaseSessionDownloadPermit(second.state, {
      now: 3_000,
      permitId: opaque24(1),
      downloadId,
    });
    expect(released.permits.map((permit) => permit.permitId)).toEqual([opaque24(2)]);
    expect(
      releaseSessionDownloadPermit(released, {
        now: 4_000,
        permitId: opaque24(1),
        downloadId,
      }),
    ).toEqual(released);
  });
});
