import type { Prisma } from '@prisma/client';

export type AudienceChannel = 'whatsapp' | 'email' | 'instagram';

export function segmentIdToTag(segmentId: string): string | undefined {
  if (!segmentId.startsWith('tag:')) return undefined;
  const tag = segmentId.slice(4).trim();
  return tag || undefined;
}

/** Empty / includes `all` → all contacts. Otherwise unique tag segment ids. */
export function normalizeSegmentIds(input?: string | string[] | null): string[] {
  const raw = Array.isArray(input) ? input : input != null && input !== '' ? [input] : [];
  const ids = raw.map((s) => String(s).trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => id === 'all')) return ['all'];
  return [...new Set(ids)];
}

/** Union of tag segments (`hasSome`); single tag uses `has`. */
export function segmentsWhere(segmentIdOrIds: string | string[]): Prisma.ContactWhereInput {
  const ids = normalizeSegmentIds(segmentIdOrIds);
  if (ids[0] === 'all') return {};
  const tags = ids.map(segmentIdToTag).filter((t): t is string => !!t);
  if (tags.length === 0) return {};
  return tags.length === 1 ? { tags: { has: tags[0] } } : { tags: { hasSome: tags } };
}

export function resolveSegmentIdsFromFilter(
  audienceType: string,
  filter: { segmentId?: string; segmentIds?: unknown; tag?: string }
): string[] {
  if (audienceType === 'all') return ['all'];
  if (audienceType === 'csv') {
    // No CSV-upload audience path exists yet (no contactIds handling anywhere
    // in this service or its callers) — fail loudly instead of silently
    // falling through to 'all' and broadcasting to the entire workspace.
    throw new Error('CSV audience upload is not supported yet');
  }
  if (Array.isArray(filter.segmentIds) && filter.segmentIds.length > 0) {
    return normalizeSegmentIds(filter.segmentIds.map(String));
  }
  if (typeof filter.segmentId === 'string' && filter.segmentId.trim()) {
    return normalizeSegmentIds(filter.segmentId);
  }
  if (typeof filter.tag === 'string' && filter.tag.trim()) {
    return [`tag:${filter.tag.trim()}`];
  }
  return ['all'];
}

/** Channel + segment ids used when persisting `totalRecipients` on create/PATCH. */
export function resolveAudienceCountArgs(
  audienceType: string,
  audienceFilter?: unknown
): { channel: AudienceChannel; segmentIds: string[] } {
  const filter =
    audienceFilter && typeof audienceFilter === 'object'
      ? (audienceFilter as {
          channel?: string;
          segmentId?: string;
          segmentIds?: unknown;
          tag?: string;
        })
      : {};
  const channel: AudienceChannel =
    filter.channel === 'email' || filter.channel === 'instagram' ? filter.channel : 'whatsapp';
  return { channel, segmentIds: resolveSegmentIdsFromFilter(audienceType, filter) };
}

export function segmentLabelFromIds(segmentIds: string | string[]): string {
  const ids = normalizeSegmentIds(segmentIds);
  if (ids[0] === 'all') return 'All contacts';
  const tags = ids.map(segmentIdToTag).filter((t): t is string => !!t);
  if (tags.length === 0) return ids.join(', ');
  if (tags.length === 1) return `Tag: ${tags[0]}`;
  return `Tags: ${tags.join(', ')}`;
}

export function audienceTagFromIds(segmentIds: string | string[]): string | undefined {
  const tags = normalizeSegmentIds(segmentIds)
    .map(segmentIdToTag)
    .filter((t): t is string => !!t);
  return tags.length > 0 ? tags.join(', ') : undefined;
}
