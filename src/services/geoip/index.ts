import { freeIpApiProvider } from './freeipapi.js';
import type { GeoIpProvider, GeoIpResult } from './types.js';

export type { GeoIpProvider, GeoIpResult } from './types.js';

const LOOKUP_TIMEOUT_MS = 2500;

/** Active provider — swap here (or via env later) without touching routes. */
let activeProvider: GeoIpProvider = freeIpApiProvider;

export function setGeoIpProvider(provider: GeoIpProvider) {
  activeProvider = provider;
}

export function getGeoIpProvider(): GeoIpProvider {
  return activeProvider;
}

export async function lookupGeoIp(ip: string): Promise<GeoIpResult | null> {
  try {
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    return await activeProvider.lookup(ip, signal);
  } catch {
    return null;
  }
}

/** Accept any IANA id the runtime can resolve (browsers: Asia/Kolkata; some Node ICU: Asia/Calcutta). */
export function isValidIanaTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string' || !tz.includes('/')) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type LocaleSuggestion = {
  country: string | null;
  timezone: string | null;
  countrySource: 'ip' | null;
  timezoneSource: 'browser' | 'ip' | null;
};

/**
 * Browser TZ wins when valid; IP fills country and (only if needed) timezone.
 */
export function buildLocaleSuggestion(input: {
  browserTimezone?: string | null;
  geo: GeoIpResult | null;
}): LocaleSuggestion {
  const browserTz = isValidIanaTimeZone(input.browserTimezone ?? null)
    ? input.browserTimezone!
    : null;
  const ipCountry = input.geo?.countryCode ?? null;
  const ipTz = isValidIanaTimeZone(input.geo?.timeZone ?? null) ? input.geo!.timeZone : null;

  if (browserTz) {
    return {
      country: ipCountry,
      timezone: browserTz,
      countrySource: ipCountry ? 'ip' : null,
      timezoneSource: 'browser',
    };
  }

  return {
    country: ipCountry,
    timezone: ipTz,
    countrySource: ipCountry ? 'ip' : null,
    timezoneSource: ipTz ? 'ip' : null,
  };
}

export function detectionHint(source: 'browser' | 'ip' | null, kind: 'country' | 'timezone'): string | null {
  if (!source) return null;
  if (kind === 'country') return 'Detected from your IP address';
  return source === 'browser' ? 'Detected from your device' : 'Detected from your IP address';
}
