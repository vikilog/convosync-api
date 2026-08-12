/**
 * Detect DATABASE_URLs that look like production (Neon / known prod hosts).
 * Used at local boot and by db-refresh-dev.sh (via node -e).
 *
 * Patterns (no secrets hardcoded):
 * - Host contains `.neon.tech` and DB name is a prod-style name (not *_dev / *_test / *_staging)
 * - Host equals PROD_DB_HOST or the host of PROD_DATABASE_URL / PROD_DIRECT_URL when set
 * - Host matches EXTRA_PROD_DB_HOST_PATTERN (regex) when set
 */

const DEVISH_DB = /_(dev|test|staging)$/i;
const PROD_STYLE_DB = /^(convosync|neondb|postgres)$/i;

export type ParsedDbUrl = {
  host: string;
  database: string;
  href: string;
};

export function parseDatabaseUrl(url: string): ParsedDbUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const database = decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0] || '');
    return { host: u.hostname.toLowerCase(), database, href: trimmed };
  } catch {
    return null;
  }
}

function hostFromEnvUrl(envVal: string | undefined): string | null {
  if (!envVal?.trim()) return null;
  return parseDatabaseUrl(envVal)?.host ?? null;
}

export function looksLikeProductionDatabaseUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const parsed = parseDatabaseUrl(url);
  if (!parsed?.host || !parsed.database) return false;

  const explicitHosts = new Set<string>();
  for (const h of [
    env.PROD_DB_HOST,
    hostFromEnvUrl(env.PROD_DATABASE_URL),
    hostFromEnvUrl(env.PROD_DIRECT_URL),
  ]) {
    if (h) explicitHosts.add(h.toLowerCase());
  }
  if (explicitHosts.has(parsed.host)) return true;

  const extra = env.EXTRA_PROD_DB_HOST_PATTERN?.trim();
  if (extra) {
    try {
      if (new RegExp(extra, 'i').test(parsed.host)) return true;
    } catch {
      // invalid pattern — ignore
    }
  }

  // Neon prod cluster: same host may also host convosync_dev — only flag prod-style DB names.
  if (parsed.host.includes('neon.tech') && !DEVISH_DB.test(parsed.database)) {
    if (PROD_STYLE_DB.test(parsed.database)) return true;
  }

  return false;
}

/**
 * Throw when running in development/local against a production-like DATABASE_URL.
 * Override with ALLOW_PROD_DB=1 for emergencies.
 */
export function assertSafeDatabaseUrlForDev(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.ALLOW_PROD_DB === '1') return;

  const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
  const isLocalish =
    nodeEnv === 'development' ||
    nodeEnv === 'test' ||
    nodeEnv === '' ||
    env.CONVOSYNC_LOCAL === '1';

  if (!isLocalish) return;
  if (!databaseUrl?.trim()) return;

  if (looksLikeProductionDatabaseUrl(databaseUrl, env)) {
    throw new Error(
      [
        'Refusing to start: DATABASE_URL looks like production while NODE_ENV is local/development.',
        'Point backend/.env at convosync_dev (local Docker or a Neon *_dev database).',
        'Emergency override: ALLOW_PROD_DB=1',
        `Host/db matched: ${parseDatabaseUrl(databaseUrl)?.host}/${parseDatabaseUrl(databaseUrl)?.database}`,
      ].join('\n')
    );
  }
}
