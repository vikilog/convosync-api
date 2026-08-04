/**
 * Natural "typing..." delay from message length.
 * Caps under WA's ~25s typing indicator window.
 */
export function typingDelayMs(text: string): number {
  const chars = Math.max(1, text.trim().length);
  // ~12 chars/sec — faster than human, still feels paced
  const ms = Math.round((chars / 12) * 1000);
  return Math.min(5000, Math.max(600, ms));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
