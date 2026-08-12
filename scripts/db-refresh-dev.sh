#!/usr/bin/env bash
# One-way prod → dev Postgres refresh for ConvoSync.
# NEVER restores into a production-like URL. Never syncs back to prod.
#
# Required:
#   PROD_DATABASE_URL or PROD_DIRECT_URL  — dump source (prefer DIRECT / non-pooled Neon)
#   DEV_DATABASE_URL  — restore target (defaults to DATABASE_URL from backend/.env)
#
# Optional:
#   --anonymize          run db-anonymize-dev.sql after restore
#   --dump-only          only write the dump file
#   --restore-only FILE  skip dump; restore from FILE
#   CONFIRM_DEV_REFRESH=1  required (destructive restore)
#   DUMP_DIR             default: backend/.tmp/db-dumps
#
# Examples:
#   CONFIRM_DEV_REFRESH=1 PROD_DIRECT_URL='postgresql://...' \
#     DEV_DATABASE_URL='postgresql://convosync:convosync_secret@localhost:5432/convosync_dev' \
#     npm run db:refresh-dev -- --anonymize
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ANONYMIZE=false
DUMP_ONLY=false
RESTORE_ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --anonymize) ANONYMIZE=true; shift ;;
    --dump-only) DUMP_ONLY=true; shift ;;
    --restore-only)
      RESTORE_ONLY="${2:?--restore-only requires a dump file}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Don't `source` .env — values may contain `;`, quotes, JSON (bash-unsafe).
SOURCE_URL="$(
  node -e "
    require('dotenv').config();
    process.stdout.write(process.env.PROD_DIRECT_URL || process.env.PROD_DATABASE_URL || '');
  "
)"
TARGET_URL="$(
  node -e "
    require('dotenv').config();
    process.stdout.write(process.env.DEV_DATABASE_URL || process.env.DATABASE_URL || '');
  "
)"

if [[ -z "$SOURCE_URL" && -z "$RESTORE_ONLY" ]]; then
  echo "Set PROD_DIRECT_URL or PROD_DATABASE_URL (read-only dump source)." >&2
  echo "Do not put the prod URL in DATABASE_URL — keep it only in PROD_* for this script." >&2
  exit 1
fi

if [[ -z "$TARGET_URL" ]]; then
  echo "Set DEV_DATABASE_URL (or DATABASE_URL pointing at convosync_dev)." >&2
  exit 1
fi

echo "==> Safety check on restore target"
npx tsx scripts/assert-dev-db-url.ts "$TARGET_URL"

if [[ "${CONFIRM_DEV_REFRESH:-}" != "1" && "$DUMP_ONLY" != true ]]; then
  echo "Refusing destructive restore without CONFIRM_DEV_REFRESH=1" >&2
  exit 1
fi

for cmd in pg_dump pg_restore psql; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing $cmd — install PostgreSQL client tools (e.g. brew install libpq && brew link --force libpq)." >&2
    exit 1
  fi
done

DUMP_DIR="${DUMP_DIR:-$ROOT/.tmp/db-dumps}"
mkdir -p "$DUMP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${RESTORE_ONLY:-$DUMP_DIR/convosync-prod-$STAMP.dump}"

if [[ -z "$RESTORE_ONLY" ]]; then
  echo "==> Dumping source (read-only) → $DUMP_FILE"
  pg_dump "$SOURCE_URL" \
    --format=custom \
    --no-owner \
    --no-acl \
    --verbose \
    --file="$DUMP_FILE"
  echo "==> Dump complete"
fi

if [[ "$DUMP_ONLY" == true ]]; then
  echo "Dump-only done: $DUMP_FILE"
  exit 0
fi

TARGET_DB="$(node -e "
  try {
    const u = new URL(process.argv[1]);
    console.log(decodeURIComponent(u.pathname.replace(/^\\//,'').split('/')[0] || ''));
  } catch { console.log(''); }
" "$TARGET_URL")"

echo "==> Restoring into $TARGET_DB"
set +e
pg_restore \
  --dbname="$TARGET_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --verbose \
  "$DUMP_FILE"
RESTORE_RC=$?
set -e
if [[ "$RESTORE_RC" -ne 0 ]]; then
  echo "pg_restore exited $RESTORE_RC — verifying Workspace table exists..." >&2
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM "Workspace"' >/dev/null
fi

if [[ "$ANONYMIZE" == true ]]; then
  echo "==> Anonymizing PII / secrets on $TARGET_DB"
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$ROOT/scripts/db-anonymize-dev.sql"
fi

echo "==> Dev refresh OK → $TARGET_DB"
echo "    Point DATABASE_URL / DIRECT_URL in backend/.env at this database."
echo "    Direction is one-way: never dump this DB back over production."
