-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "currentHandler" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "takenOverAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "takenOverByUserId" TEXT;
