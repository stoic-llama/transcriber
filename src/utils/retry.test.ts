import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, retryWithBackoff } from './retry';

const noSleep = vi.fn(async () => {});

describe('retryWithBackoff', () => {
  it('returns the first successful result', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValueOnce('ok');
    await expect(retryWithBackoff(fn, { isRetryable: () => true, sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, isRetryable: () => true, sleep: noSleep }),
    ).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad key'));
    await expect(retryWithBackoff(fn, { isRetryable: () => false, sleep: noSleep })).rejects.toThrow('bad key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential delays and honours a larger Retry-After', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('x'));
    await retryWithBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      random: () => 0.999999,
      isRetryable: () => true,
      retryAfterMs: (_e) => (delays.length === 1 ? 30_000 : undefined),
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});
    expect(delays).toEqual([1000, 30_000, 4000]);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(backoffDelay(20, 1000, 60_000, () => 0.999999)).toBe(60_000);
    expect(backoffDelay(1, 1000, 60_000, () => 0)).toBe(500);
  });

  it('aborts while waiting', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('transient');
    });
    await expect(
      retryWithBackoff(fn, { isRetryable: () => true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
