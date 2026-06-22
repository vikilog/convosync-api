import { config } from '../config.js';

function isRelaxedDevOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.devtunnels.ms')) return true;
    if (
      host.endsWith('.ngrok-free.app') ||
      host.endsWith('.ngrok.io') ||
      host.endsWith('.ngrok.app')
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (config.corsAllowedOrigins.includes(origin)) return true;
  if (config.corsDevRelaxed && isRelaxedDevOrigin(origin)) return true;
  return false;
}

/** Fastify @fastify/cors and Socket.io origin callback */
export function corsOriginDelegate(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void
) {
  if (!origin || isCorsOriginAllowed(origin)) {
    cb(null, true);
    return;
  }
  console.warn(`[CORS] blocked origin: ${origin}`);
  console.warn('[CORS] configured allowlist:', config.corsAllowedOrigins);
  if (config.corsDevRelaxed) {
    console.warn('[CORS] dev relaxed mode is on — add this origin to FRONTEND_URL or CORS_ALLOWED_ORIGINS');
  }
  cb(null, false);
}
