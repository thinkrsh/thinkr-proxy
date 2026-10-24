import { describe, expect, it } from 'vitest';

import { createFixedWindowLimiter } from '../src/lib/rate-limit.js';

const options = { limit: 2, windowMs: 1_000, sweepThreshold: 1 };

describe('createFixedWindowLimiter', () => {
  it('allows the limit in one window, then refuses', () => {
    const limiter = createFixedWindowLimiter(options);
    expect([0, 10, 20].map((now) => limiter.take('a', now))).toEqual([true, true, false]);
  });

  it('opens a new window when the old one expires', () => {
    const limiter = createFixedWindowLimiter(options);
    limiter.take('a', 0);
    limiter.take('a', 1);
    expect(limiter.take('a', 1_000)).toBe(true);
  });

  it('counts each key on its own', () => {
    const limiter = createFixedWindowLimiter(options);
    limiter.take('a', 0);
    limiter.take('a', 0);
    expect(limiter.take('b', 0)).toBe(true);
  });

  it('keeps counting correctly after a sweep of expired windows', () => {
    const limiter = createFixedWindowLimiter(options);
    limiter.take('a', 0);
    limiter.take('b', 0);
    limiter.take('c', 5_000);
    expect(limiter.take('c', 5_001)).toBe(true);
    expect(limiter.take('c', 5_002)).toBe(false);
  });
});
