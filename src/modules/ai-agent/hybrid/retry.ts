/** Retry with linear backoff for transient Redis/pgvector failures. */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; delayMs?: number; label?: string }
): Promise<T> {
  const retries = opts?.retries ?? 2;
  const delayMs = opts?.delayMs ?? 150;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }

  throw lastErr;
}
