#!/usr/bin/env bash
# Mark every Prisma migration as already applied on a dev DB whose schema came from
# `prisma db push` (so `migrate deploy` does not re-run history and hit P3018).
#
# Required:
#   CONFIRM_MIGRATE_BASELINE=1
#   DATABASE_URL (or DIRECT_URL) pointing at *_dev / *_test / *_staging
#
# Usage (from backend/):
#   CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev
#
# After an empty local DB:
#   npm run db:push
#   CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev
#
# If a migrate deploy failed mid-way (e.g. pgvector HNSW):
#   npx prisma migrate resolve --rolled-back 20260724130000_pgvector_knowledge_chunks \
#     --schema=src/prisma/schema.prisma
#   CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCHEMA="${PRISMA_SCHEMA:-src/prisma/schema.prisma}"
MIGRATIONS_DIR="$(dirname "$SCHEMA")/migrations"

# Don't `source` .env — values may contain `;`, quotes, JSON (bash-unsafe).
# Prisma CLI loads .env itself for migrate resolve; we only need the URL for the guard.
TARGET_URL="$(
  node -e "
    require('dotenv').config();
    process.stdout.write(process.env.DIRECT_URL || process.env.DATABASE_URL || '');
  "
)"
if [[ -z "$TARGET_URL" ]]; then
  echo "Set DATABASE_URL (or DIRECT_URL) to your convosync_dev database." >&2
  exit 1
fi

if [[ "${CONFIRM_MIGRATE_BASELINE:-}" != "1" ]]; then
  echo "Refusing baseline without CONFIRM_MIGRATE_BASELINE=1" >&2
  echo "This marks ALL migrations as applied without running SQL." >&2
  exit 1
fi

echo "==> Safety check (dev/test/staging only)"
npx tsx scripts/assert-dev-db-url.ts "$TARGET_URL"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "Migrations dir not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

echo "==> Marking all migrations applied on $(
  node -e "
    try {
      const u = new URL(process.argv[1]);
      console.log(decodeURIComponent(u.pathname.replace(/^\\//,'').split('/')[0] || ''));
    } catch { console.log('?'); }
  " "$TARGET_URL"
)"

applied=0
skipped=0
recovered=0

# Lexicographic folder names = Prisma migration order
while IFS= read -r -d '' path; do
  name="$(basename "$path")"
  [[ -f "$path/migration.sql" ]] || continue

  err_file="$(mktemp)"
  if npx prisma migrate resolve --applied "$name" --schema="$SCHEMA" >"$err_file" 2>&1; then
    echo "  applied: $name"
    applied=$((applied + 1))
    rm -f "$err_file"
    continue
  fi

  if grep -Eqi 'already recorded as applied|P3008' "$err_file"; then
    echo "  skip (already applied): $name"
    skipped=$((skipped + 1))
    rm -f "$err_file"
    continue
  fi

  # Failed / rolled-back mid-deploy → clear then mark applied
  if npx prisma migrate resolve --rolled-back "$name" --schema="$SCHEMA" >/dev/null 2>&1 \
    && npx prisma migrate resolve --applied "$name" --schema="$SCHEMA" >/dev/null 2>&1; then
    echo "  recovered (rolled-back → applied): $name"
    recovered=$((recovered + 1))
    rm -f "$err_file"
    continue
  fi

  echo "Failed to baseline: $name" >&2
  cat "$err_file" >&2
  rm -f "$err_file"
  exit 1
done < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

echo "==> Baseline OK — applied=$applied skipped=$skipped recovered=$recovered"
echo "    Do not run migrate deploy to 'catch up' on this DB; schema is already from db push."
echo "    Future empty local DB: db:push then CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev"
