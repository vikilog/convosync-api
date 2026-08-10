import type { GeoIpProvider, GeoIpResult } from './types.js';

/** Common country → primary IANA zone when the API returns a multi-zone list. */
const COUNTRY_PRIMARY_TZ: Record<string, string> = {
  IN: 'Asia/Kolkata',
  US: 'America/New_York',
  GB: 'Europe/London',
  AE: 'Asia/Dubai',
  SG: 'Asia/Singapore',
  AU: 'Australia/Sydney',
  DE: 'Europe/Berlin',
  CA: 'America/Toronto',
  FR: 'Europe/Paris',
  JP: 'Asia/Tokyo',
  BR: 'America/Sao_Paulo',
  ZA: 'Africa/Johannesburg',
  NZ: 'Pacific/Auckland',
};

function pickTimeZone(countryCode: string | null, zones: string[]): string | null {
  if (!zones.length) return null;
  if (countryCode) {
    const preferred = COUNTRY_PRIMARY_TZ[countryCode];
    // ponytail: multi-zone countries (US) — primary map beats alphabetical first entry (America/Adak); upgrade: lat/lng tz lookup
    if (preferred && zones.includes(preferred)) return preferred;
    if (preferred) return preferred;
  }
  return zones[0] ?? null;
}

type FreeIpApiJson = {
  countryCode?: string;
  timeZones?: string[];
};

export const freeIpApiProvider: GeoIpProvider = {
  id: 'freeipapi',

  async lookup(ip: string, signal?: AbortSignal): Promise<GeoIpResult> {
    const url = `https://freeipapi.com/api/json/${encodeURIComponent(ip)}`;
    const res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`freeipapi HTTP ${res.status}`);
    }
    const data = (await res.json()) as FreeIpApiJson;
    const countryCode =
      typeof data.countryCode === 'string' && /^[A-Z]{2}$/i.test(data.countryCode)
        ? data.countryCode.toUpperCase()
        : null;
    const zones = Array.isArray(data.timeZones)
      ? data.timeZones.map((z) => String(z)).filter(Boolean)
      : [];
    return {
      countryCode,
      timeZone: pickTimeZone(countryCode, zones),
    };
  },
};
