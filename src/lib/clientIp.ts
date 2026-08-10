import type { FastifyRequest } from 'fastify';

/** Strip IPv4-mapped IPv6 prefix (`:ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function isLoopback(ip: string): boolean {
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1' || n === '0.0.0.0';
}

function isPublicIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n || isLoopback(n)) return false;
  // Crude private-range skip — geo lookup is useless for these.
  if (n.startsWith('10.')) return false;
  if (n.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(n)) return false;
  return true;
}

/**
 * Client IP for geo lookup. Prefers Fastify `request.ip` (respects trustProxy),
 * then the left-most public address in X-Forwarded-For.
 */
export function clientIpFromRequest(request: FastifyRequest): string | null {
  if (request.ip && isPublicIp(request.ip)) return normalizeIp(request.ip);

  const ips = request.ips?.length ? request.ips : [];
  for (const candidate of ips) {
    if (isPublicIp(candidate)) return normalizeIp(candidate);
  }

  const xff = request.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const candidate = part.trim();
      if (candidate && isPublicIp(candidate)) return normalizeIp(candidate);
    }
  }

  return null;
}
