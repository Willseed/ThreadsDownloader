import { describe, expect, it } from 'vitest';

import {
  decideSessionIssuance,
  MAX_SESSION_ISSUANCE_BURST,
  MAX_SESSION_ISSUANCE_CAPACITY,
  pruneSessionIssuanceEvents,
  SESSION_ISSUANCE_BURST_WINDOW_MS,
  SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
} from '../src/security/session-issuance-rate-limit.js';

const now = 50_000_000;

describe('session issuance rate-limit policy', () => {
  it('admits the sixtieth event and denies the sixty-first inside the rolling minute', () => {
    const fiftyNine = Array.from(
      { length: MAX_SESSION_ISSUANCE_BURST - 1 },
      (_, index) => now - 59_000 + index,
    );
    expect(decideSessionIssuance(fiftyNine, now)).toEqual({ allowed: true });

    const sixty = [...fiftyNine, now];
    expect(decideSessionIssuance(sixty, now)).toEqual({
      allowed: false,
      retryAt: fiftyNine[0]! + SESSION_ISSUANCE_BURST_WINDOW_MS,
    });
    const sixtyOne = [...sixty, now + 1];
    expect(decideSessionIssuance(sixtyOne, now + 1)).toEqual({
      allowed: false,
      retryAt: fiftyNine[1]! + SESSION_ISSUANCE_BURST_WINDOW_MS,
    });
  });

  it('admits the 512th capacity event and denies the 513th for twelve hours', () => {
    const fiveHundredEleven = Array.from(
      { length: MAX_SESSION_ISSUANCE_CAPACITY - 1 },
      (_, index) => now - 43_000_000 + index * 70_000,
    );
    expect(decideSessionIssuance(fiveHundredEleven, now)).toEqual({ allowed: true });

    const fiveHundredTwelve = [...fiveHundredEleven, now];
    expect(decideSessionIssuance(fiveHundredTwelve, now)).toEqual({
      allowed: false,
      retryAt: fiveHundredEleven[0]! + SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
    });
  });

  it('prunes at the exact window boundary while retaining one millisecond inside it', () => {
    expect(
      pruneSessionIssuanceEvents(
        [now - SESSION_ISSUANCE_CAPACITY_WINDOW_MS, now - SESSION_ISSUANCE_CAPACITY_WINDOW_MS + 1],
        now,
      ),
    ).toEqual([now - SESSION_ISSUANCE_CAPACITY_WINDOW_MS + 1]);
  });

  it('releases the burst slot at the exact rolling-minute boundary', () => {
    const recent = Array.from(
      { length: MAX_SESSION_ISSUANCE_BURST - 1 },
      (_, index) => now - 50_000 + index,
    );
    expect(decideSessionIssuance([now - SESSION_ISSUANCE_BURST_WINDOW_MS, ...recent], now)).toEqual(
      { allowed: true },
    );
    expect(
      decideSessionIssuance([now - SESSION_ISSUANCE_BURST_WINDOW_MS + 1, ...recent], now),
    ).toEqual({
      allowed: false,
      retryAt: now + 1,
    });
  });

  it('uses the later release deadline when burst and capacity both block', () => {
    const capacityEvents = Array.from(
      { length: MAX_SESSION_ISSUANCE_CAPACITY - MAX_SESSION_ISSUANCE_BURST },
      (_, index) => now - 40_000_000 + index * 80_000,
    );
    const burstEvents = Array.from(
      { length: MAX_SESSION_ISSUANCE_BURST },
      (_, index) => now - 10_000 + index,
    );
    const capacityRetryAt = capacityEvents[0]! + SESSION_ISSUANCE_CAPACITY_WINDOW_MS;
    const burstRetryAt = burstEvents[0]! + SESSION_ISSUANCE_BURST_WINDOW_MS;
    expect(capacityRetryAt).toBeGreaterThan(burstRetryAt);
    expect(decideSessionIssuance([...capacityEvents, ...burstEvents], now)).toEqual({
      allowed: false,
      retryAt: capacityRetryAt,
    });
  });
});
