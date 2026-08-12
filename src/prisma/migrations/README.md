# Prisma migrate history (PostgreSQL)

SQL migrations in this folder apply to **PostgreSQL** only.

## Recommended local empty DB (this repo)

History is incomplete for a greenfield `migrate deploy` (core tables came from earlier `db push` / non-baseline dumps). Prefer:

```bash
cd backend
# ensure DATABASE_URL → convosync_dev (or *_test / *_staging)
npm run db:push
CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev
```

That syncs schema once, then marks every migration folder as applied so later `migrate deploy` is a no-op instead of P3018 conflicts.

## Stuck after `db push` + failed `migrate deploy` (P3018)

Example: `20260724130000_pgvector_knowledge_chunks` failed with `column does not have dimensions` (HNSW needs `vector(1536)`, not bare `vector` from an old push).

```bash
cd backend

# 1) Clear the failed migration row
npx prisma migrate resolve --rolled-back 20260724130000_pgvector_knowledge_chunks \
  --schema=src/prisma/schema.prisma

# 2) One-shot baseline (do NOT keep fighting deploy)
CONFIRM_MIGRATE_BASELINE=1 npm run db:migrate-baseline-dev

# Optional: fix embedding typmod + HNSW on the already-pushed table
# (also safe if you re-run deploy later — migration.sql is idempotent)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f src/prisma/migrations/20260724130000_pgvector_knowledge_chunks/migration.sql
```

`db:migrate-baseline-dev` refuses prod Neon / non-`_*{dev,test,staging}` DB names and requires `CONFIRM_MIGRATE_BASELINE=1`.

## Alternative: true migrate-only from empty

Drop the DB, `CREATE EXTENSION vector;`, then only `migrate deploy`. Still not ideal here — early core tables may be missing from history. Prefer **db push + baseline** for local.

## Production / CI

```bash
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

Never run the baseline script against production.
