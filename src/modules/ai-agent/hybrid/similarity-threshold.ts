import { config } from '../../../config.js';

/**
 * Validate low bar for RAG. Rejects 1.0 — cosine almost never equals 1, so
 * threshold=1 disables vector retrieval and used to drop lexical hits scored at 0.7.
 * null → caller uses env default (0.70).
 */
export function parseSimilarityLowThreshold(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value >= 1) return null;
  return value;
}

/**
 * Per-agent low bar from `AiAgent.escalationRules.similarityLowThreshold`.
 * Falls back to env `SIMILARITY_LOW_THRESHOLD` (default 0.70).
 */
export function similarityLowFromEscalationRules(
  escalationRules: unknown,
  fallback = config.ai.similarityLowThreshold
): number {
  if (escalationRules && typeof escalationRules === 'object' && !Array.isArray(escalationRules)) {
    const parsed = parseSimilarityLowThreshold(
      (escalationRules as Record<string, unknown>).similarityLowThreshold
    );
    if (parsed != null) return parsed;
  }
  return fallback;
}

/** Merge threshold into escalationRules; `null` clears the override (env default). */
export function withSimilarityLowThreshold(
  existing: unknown,
  threshold: number | null
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (threshold == null) {
    delete base.similarityLowThreshold;
  } else {
    base.similarityLowThreshold = threshold;
  }
  return base;
}
