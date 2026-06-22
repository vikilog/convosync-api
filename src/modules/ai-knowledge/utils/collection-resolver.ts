/** Case-insensitive lookup: lowercase name → actual MongoDB collection name. */
export function buildCollectionIndex(names: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of names) {
    index.set(name.toLowerCase(), name);
  }
  return index;
}

export function resolveCollectionName(
  index: Map<string, string>,
  candidates: readonly string[]
): string | null {
  for (const candidate of candidates) {
    const hit = index.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Collections likely to hold salon/venue business data (PascalCase Mongoose names included). */
export const ENTITY_COLLECTION_PATTERN =
  /service|staff|product|client|customer|member|voucher|package|appointment|booking|categor|branch|venue|setting|faq|policy|offer|amenity|gift|inventory|stock|commission|sale|look|banner|template|review|partner|notification|message|chat|otp|user|employee|stylist|treatment|plan|coupon|combo|bundle|location|store|business|company|pincode|country|report|target|fee|issue|recommendation|attribute|subcategor|servicing|activation|credential|delivery|indicator|activity|transaction|tip|split|usage|field|visit|bank|associate|creative|studio|read|status|generated|support|ticket|onboarding|whatsapp|registered|special|item|payment|address|activation|monthly|outbound|template|subcategory|sub_category/i;

export function isEntityLikeCollection(name: string): boolean {
  return ENTITY_COLLECTION_PATTERN.test(name);
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
