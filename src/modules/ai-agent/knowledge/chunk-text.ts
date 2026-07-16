const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;

/** Split long knowledge text into embeddable chunks with light overlap. */
export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf('\n\n', end);
      const sentenceBreak = normalized.lastIndexOf('. ', end);
      const softBreak = Math.max(paragraphBreak, sentenceBreak);
      if (softBreak > start + Math.floor(chunkSize * 0.5)) {
        end = softBreak + (sentenceBreak === softBreak ? 2 : 2);
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function buildKnowledgeItemText(item: {
  title: string;
  type: string;
  content?: string | null;
  url?: string | null;
}): string {
  const parts = [`Title: ${item.title}`, `Type: ${item.type}`];
  if (item.url?.trim()) parts.push(`URL: ${item.url.trim()}`);
  if (item.content?.trim()) parts.push(item.content.trim());
  return parts.join('\n\n').trim();
}
