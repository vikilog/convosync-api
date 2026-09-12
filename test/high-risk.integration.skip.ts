/**
 * High-risk auth/tenant/webhook flows still pending (do not implement here).
 * Postgres+pgvector smoke: test/pgvector.integration.test.ts (Testcontainers, random ports).
 * Manual compose fallback uses 5434 — never 5433 (local app DB).
 *
 *   docker compose -f backend/test/docker-compose.test.yml up -d --wait
 *   cd backend
 *   DATABASE_URL=postgresql://convosync:convosync_test@127.0.0.1:5434/convosync_test \
 *   DIRECT_URL=postgresql://convosync:convosync_test@127.0.0.1:5434/convosync_test \
 *   REDIS_URL=redis://127.0.0.1:6380 \
 *     npx prisma db push --schema=src/prisma/schema.prisma
 *   then add Vitest files for rewrite-plan [01] §6:
 *     - auth chain: login → JWT → workspace access → subscription gate
 *     - tenant isolation: workspace A never reads/writes workspace B
 *     - webhook idempotency: replay the same Razorpay/Meta payload twice → one process
 *   docker compose -f backend/test/docker-compose.test.yml down
 */
console.log('high-risk.integration.skip.ts: skipped (auth/tenant/webhook flows not implemented)');
