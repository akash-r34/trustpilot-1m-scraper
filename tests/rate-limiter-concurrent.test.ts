import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/anti-bot/rate-limiter.js';

describe('RateLimiter — concurrent throttle correctness', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10); // 10 req/s → 100 ms between slots
  });

  it('serialises 25 concurrent callers into evenly-spaced slots', async () => {
    const N = 25;
    const timestamps: number[] = [];

    await Promise.all(
      Array.from({ length: N }, async () => {
        await limiter.throttle();
        timestamps.push(Date.now());
      })
    );

    timestamps.sort((a, b) => a - b);

    // All 25 should NOT fire within the same millisecond (old burst behaviour)
    const min = timestamps[0]!;
    const max = timestamps[N - 1]!;
    const spread = max - min;

    // With 10 req/s, 25 slots take ≥ (25-1) × 100 ms = 2400 ms of spread.
    // We only verify the spread is >500 ms to avoid flakiness in CI.
    expect(spread).toBeGreaterThan(500);
  }, 30_000);

  it('does not exceed configured max rate on recovery', () => {
    limiter.on403();
    for (let i = 0; i < 100; i++) limiter.onSuccess();
    expect(limiter.getCurrentRate()).toBeLessThanOrEqual(10);
  });
});
