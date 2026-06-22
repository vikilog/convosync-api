const RETRYABLE = new Set([429, 500, 503]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatusCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: number; response?: { status?: number }; status?: number };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.response?.status === 'number') return e.response.status;
  return null;
}

export function isRetryableGoogleError(err: unknown): boolean {
  const code = getStatusCode(err);
  return code !== null && RETRYABLE.has(code);
}

export async function withGoogleRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  let delayMs = 1000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableGoogleError(err) || attempt === maxRetries) break;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 8000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Google API request failed');
}
