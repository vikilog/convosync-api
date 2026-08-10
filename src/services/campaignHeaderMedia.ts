/**
 * Campaign WhatsApp templates with IMAGE/VIDEO/DOCUMENT headers need media at send time.
 * Override may come from audienceFilter (upload storage key or media-gallery asset).
 */

export type CampaignHeaderMediaOverride = {
  headerMediaStorageKey?: string;
  headerMediaMimeType?: string;
  headerMediaFileName?: string;
  headerMediaAssetId?: string;
};

export function parseCampaignHeaderMediaOverride(raw: unknown): CampaignHeaderMediaOverride {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const str = (k: string) => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  return {
    headerMediaStorageKey: str('headerMediaStorageKey'),
    headerMediaMimeType: str('headerMediaMimeType'),
    headerMediaFileName: str('headerMediaFileName'),
    headerMediaAssetId: str('headerMediaAssetId'),
  };
}

export function hasCampaignHeaderMediaSource(
  override: CampaignHeaderMediaOverride,
  templateStorageKey: string | null | undefined
): boolean {
  return Boolean(
    override.headerMediaStorageKey ||
      override.headerMediaAssetId ||
      (typeof templateStorageKey === 'string' && templateStorageKey.trim())
  );
}
