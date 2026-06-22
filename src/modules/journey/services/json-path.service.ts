/**
 * Reads a value from JSON using dot/bracket notation.
 * Examples: `data.accountId`, `items[0].name`, `$` (whole root)
 */
export function getByJsonPath(root: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$' || trimmed === '.') return root;

  const segments = trimmed
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let current: unknown = root;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function valueToStoredString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
