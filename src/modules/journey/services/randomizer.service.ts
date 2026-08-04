export type RandomizerPath = {
  id: string;
  label?: string;
  weight: number;
};

/**
 * Pick an outgoing edge by percentage weight (A/B paths).
 * Falls back to first edge if weights/edges don't line up.
 */
export function pickWeightedEdge<T extends { conditionValue: string | null }>(
  edges: T[],
  paths: RandomizerPath[],
  random: () => number = Math.random
): T | undefined {
  if (edges.length === 0) return undefined;

  const usable = paths
    .map((p) => ({
      id: String(p.id),
      weight: Math.max(0, Number(p.weight) || 0),
      edge: edges.find((e) => e.conditionValue === String(p.id)),
    }))
    .filter((p) => p.weight > 0 && p.edge);

  if (usable.length === 0) {
    return (
      edges.find((e) => e.conditionValue === 'default' || e.conditionValue == null) ??
      edges[0]
    );
  }

  const total = usable.reduce((s, p) => s + p.weight, 0);
  let roll = random() * total;
  for (const p of usable) {
    roll -= p.weight;
    if (roll <= 0) return p.edge;
  }
  return usable[usable.length - 1]?.edge;
}

export function normalizeRandomizerPaths(raw: unknown): RandomizerPath[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      { id: 'a', label: 'Path A', weight: 50 },
      { id: 'b', label: 'Path B', weight: 50 },
    ];
  }
  return raw
    .map((p, i) => {
      const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
      const id = String(obj.id ?? `path_${i}`).trim() || `path_${i}`;
      return {
        id,
        label: String(obj.label ?? id),
        weight: Math.max(0, Number(obj.weight) || 0),
      };
    })
    .slice(0, 6);
}
