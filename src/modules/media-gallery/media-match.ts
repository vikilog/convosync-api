/** Pure helpers for media gallery selection + duplicate guard (unit-testable). */

export const MEDIA_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

export type MediaCatalogItem = {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
};

export function filterByAudienceScope<T extends { scope: string }>(
  items: T[],
  audience: 'customer' | 'partner' = 'customer'
): T[] {
  return items.filter((item) => item.scope === 'both' || item.scope === audience);
}

export function excludeRecentlySent<T extends { id: string }>(
  items: T[],
  recentlySentIds: Set<string>
): T[] {
  return items.filter((item) => !recentlySentIds.has(item.id));
}

/** Build Meta Cloud API message body fragment for image vs document. */
export function buildWhatsAppMediaPayload(params: {
  kind: 'image' | 'video' | 'audio' | 'document';
  waMediaId: string;
  caption?: string;
  filename?: string;
}): Record<string, unknown> {
  const mediaPayload: Record<string, unknown> = { id: params.waMediaId };
  if (
    params.caption?.trim() &&
    (params.kind === 'image' || params.kind === 'video' || params.kind === 'document')
  ) {
    mediaPayload.caption = params.caption.trim();
  }
  if (params.kind === 'document' && params.filename?.trim()) {
    mediaPayload.filename = params.filename.trim();
  }
  return {
    messaging_product: 'whatsapp',
    type: params.kind,
    [params.kind]: mediaPayload,
  };
}

export function parseMediaPickJson(raw: string): { mediaId: string | null } {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return { mediaId: null };
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
      mediaId?: string | null;
    };
    const id = parsed.mediaId?.trim();
    return { mediaId: id || null };
  } catch {
    return { mediaId: null };
  }
}

export function buildMediaSelectPrompt(
  query: string,
  catalog: MediaCatalogItem[]
): { system: string; user: string } {
  return {
    system: `You pick at most one media asset that strongly matches the user request.
Reply with JSON only: {"mediaId":"<id>"} or {"mediaId":null}.
Rules:
- Pick ONLY when the user explicitly asks for a file/image/PDF/brochure/catalog/menu/price list (send/share/bhejo/dikhao).
- Pick when the question is about price/plans AND a price list / pricing PDF / brochure clearly matches.
- Prefer null for product/feature explanations ("what is X", "features btao") unless they also ask to send a file.
- Prefer null when the asset is only loosely related, or for greetings/farewells/unrelated chat.
- Never invent an id not in the catalog.`,
    user: `User query:\n${query}\n\nCatalog:\n${JSON.stringify(catalog, null, 2)}`,
  };
}

const KEYWORD_STOP = new Set(
  'a an the is are was were to of in on for with and or but if so it this that i you we they me my your our please hi hello kya hai ke ki ka ko se me mein do dedo bhejo bhej'.split(
    ' '
  )
);

/**
 * When the LLM picker returns null, score title/tags/description overlap.
 * Requires score >= 2 so a single short token alone is not enough.
 * Also requires an explicit media/pricing cue — brand-name overlap alone must not attach files.
 */
export function keywordMediaFallback(
  query: string,
  catalog: MediaCatalogItem[]
): string | null {
  const wantsImage = /\b(image|photo|pic|picture|intro\s*image|dikhao?)\b/i.test(query);
  const wantsPdf = /\b(pdf|document|brochure|catalog|catalogue|price\s*list|menu|flyer)\b/i.test(
    query
  );
  const wantsSend =
    /\b(bhejo|bhej\s*do|dedo|de\s*do|send|share|download|file)\b/i.test(query);
  const wantsPricing = /\b(price|pricing|plan|plans|cost|kitna|fees|rate\s*list)\b/i.test(query);
  if (!wantsImage && !wantsPdf && !wantsSend && !wantsPricing) return null;

  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !KEYWORD_STOP.has(t));
  if (tokens.length === 0 || catalog.length === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const item of catalog) {
    const hay = `${item.title} ${item.description} ${item.tags.join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += t.length >= 5 ? 2 : 1;
    }
    if (wantsImage && (item.type === 'image' || /\b(image|photo|intro)\b/i.test(hay))) score += 1;
    if (wantsPdf && (item.type === 'pdf' || item.type === 'document')) score += 1;
    if (wantsPricing && /\b(price|pricing|plan|brochure)\b/i.test(hay)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { id: item.id, score };
  }
  return best && best.score >= 2 ? best.id : null;
}
