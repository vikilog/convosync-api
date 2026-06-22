/** Field names that scope documents to a venue/salon (singular, plural, nested). */
export const VENUE_SCOPE_FIELD_NAMES = [
  'venueIds',
  'venueId',
  'venue_id',
  'venue',
  'branchIds',
  'branchId',
  'branch_id',
  'branch',
  'salonIds',
  'salonId',
  'salon_id',
  'salon',
  'locationIds',
  'locationId',
  'location_id',
  'location',
  'businessIds',
  'businessId',
  'business_id',
  'business',
  'companyIds',
  'companyId',
  'company_id',
  'company',
  'storeIds',
  'storeId',
  'store_id',
  'store',
  'partnerIds',
  'partnerId',
  'partner_id',
] as const;

export const VENUE_SCOPE_FIELD_PATTERN = new RegExp(
  `^(${VENUE_SCOPE_FIELD_NAMES.join('|')})$`,
  'i'
);

/** Fallback when sample inspection finds no scope fields on entity collections. */
export const DEFAULT_VENUE_SCOPE_FIELDS = [
  'venueIds',
  'venueId',
  'venue',
  'partnerId',
  'salonId',
  'branchId',
  'locationId',
] as const;

export type VenueScopeContext = {
  partnerId?: string;
  franchiseId?: string;
};

export function extractVenueScopeContext(
  venueDoc: Record<string, unknown> | null | undefined
): VenueScopeContext {
  if (!venueDoc) return {};
  const ctx: VenueScopeContext = {};
  const partner = venueDoc.partnerId ?? venueDoc.partner_id;
  const franchise = venueDoc.franchiseId ?? venueDoc.franchise_id;
  if (partner != null) {
    ctx.partnerId =
      typeof partner === 'object' && partner !== null && 'toString' in partner
        ? String((partner as { toString: () => string }).toString())
        : String(partner);
  }
  if (franchise != null) {
    ctx.franchiseId =
      typeof franchise === 'object' && franchise !== null && 'toString' in franchise
        ? String((franchise as { toString: () => string }).toString())
        : String(franchise);
  }
  return ctx;
}

/** When docs include venueIds[], keep only rows scoped to this venue. */
export function filterDocsByVenueMembership(
  docs: import('mongodb').Document[],
  venueId: string
): import('mongodb').Document[] {
  const oidHex = venueId.toLowerCase();
  return docs.filter((doc) => {
    const plain = doc as Record<string, unknown>;
    const venueIds = plain.venueIds ?? plain.venue_ids;
    if (!Array.isArray(venueIds) || venueIds.length === 0) return true;
    return venueIds.some((id) => {
      if (id == null) return false;
      if (typeof id === 'string') return id.toLowerCase() === oidHex;
      if (typeof id === 'object' && id !== null && 'toHexString' in id) {
        return (id as { toHexString: () => string }).toHexString().toLowerCase() === oidHex;
      }
      return String(id).toLowerCase() === oidHex;
    });
  });
}
