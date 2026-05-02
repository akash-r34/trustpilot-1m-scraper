import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpError) {
    // Permanent 4xx: don't retry (except 408 Request Timeout, 429 Rate Limit)
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return err.statusCode === 408 || err.statusCode === 429;
    }
    return true;
  }
  // AbortError from our timeout is retryable (transient network issue)
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    isRetryable?: (err: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = 'operation', isRetryable = () => true } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
      logger.warn({ label, attempt, delay: Math.round(delay) }, 'Retrying after error');
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
