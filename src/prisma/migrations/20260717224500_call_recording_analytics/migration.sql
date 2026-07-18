-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingStatus" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingEgressId" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingStorageKey" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingUrl" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingStartedAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingEndedAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingDurationSeconds" INTEGER;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingCodec" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingFileSize" INTEGER;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recordingError" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "analyticsJson" JSONB;
