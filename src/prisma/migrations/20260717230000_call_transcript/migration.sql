-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptStatus" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptText" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptJson" JSONB;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptLanguage" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptError" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "transcriptAt" TIMESTAMP(3);
