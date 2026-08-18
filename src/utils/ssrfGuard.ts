import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * Blocks loopback/private/link-local/CGNAT ranges, including the
 * 169.254.169.254 cloud metadata endpoint that lives inside 169.254.0.0/16.
 * Shared by every place that fetches a URL supplied by an external party
 * (journey webhook nodes, inbound WhatsApp/Instagram/Messenger media) — runs
 * on every fetch, not just at save time, to also cover DNS answers that
 * change after the URL was first accepted.
 */
export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^::ffff:/i, '');
  if (net.isIPv4(ip)) {
    if (ip === '0.0.0.0' || ip.startsWith('127.')) return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith('169.254.')) return true; // link-local + cloud metadata
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    return false;
  }
  return true; // couldn't parse — block rather than guess
}

/** Resolves + validates the host, returning the address to pin the connection to. */
export async function resolveAllowedAddress(
  hostname: string
): Promise<{ address: string; family: number }> {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('URL resolves to a blocked address');
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }
  const records = await dns.promises.lookup(hostname, { all: true });
  if (!records.length) throw new Error('URL could not be resolved');
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error('URL resolves to a blocked address');
    }
  }
  return records[0];
}

/** Pins the socket to the pre-validated address so DNS can't change between check and connect. */
function pinnedLookup(address: string, family: number): typeof dns.lookup {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function' ? (options as (...a: unknown[]) => void) : (callback as (...a: unknown[]) => void);
    cb(null, address, family);
  }) as typeof dns.lookup;
}

/**
 * Validates `url`'s scheme + resolved address against the block list and
 * returns http/https agents pinned to that pre-validated address, plus the
 * validated URL string to pass to the HTTP client unchanged.
 */
export async function ssrfSafeRequestAgents(
  url: string
): Promise<{ url: string; httpAgent: http.Agent; httpsAgent: https.Agent }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  const { address, family } = await resolveAllowedAddress(parsed.hostname);
  const lookup = pinnedLookup(address, family);
  return {
    url,
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  };
}
