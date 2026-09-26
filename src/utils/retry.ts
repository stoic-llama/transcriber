import { RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_DELAY_MS } from '../config';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decide whether an error is worth another attempt. */
  isRetryable: (error: unknown) => boolean;
  /** Server-requested delay (e.g. Retry-After), overrides the backoff when larger. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Called before each attempt (1-based). */
  onAttempt?: (attempt: number) => void;
  /** Called after a failed attempt that will be retried. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with "full jitter" in the upper half: base·2^(n-1) · [0.5, 1). */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + random() / 2));
}

/**
 * Runs `fn` until it succeeds, a non-retryable error occurs, the attempt budget
 * is spent, or `signal` aborts. The last error is rethrown.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const doSleep = options.sleep ?? sleep;

  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw abortError();
    options.onAttempt?.(attempt);
    try {
      return await fn(attempt);
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (isAbortError(error)) throw error;
      if (attempt >= maxAttempts || !options.isRetryable(error)) throw error;
      const backoff = backoffDelay(attempt, baseDelayMs, maxDelayMs, options.random);
      const requested = options.retryAfterMs?.(error);
      const delay = Math.min(maxDelayMs, Math.max(backoff, requested ?? 0));
      options.onRetry?.(error, attempt, delay);
      await doSleep(delay, options.signal);
    }
  }
}
