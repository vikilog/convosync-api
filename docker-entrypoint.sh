#!/bin/sh
set -e

echo "[convosync-backend] Applying database schema..."
npx prisma db push --schema=src/prisma/schema.prisma --skip-generate

echo "[convosync-backend] Starting server on port ${PORT:-4000}..."
exec npx tsx src/index.ts
