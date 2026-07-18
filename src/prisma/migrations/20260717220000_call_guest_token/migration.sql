-- Guest link fields for browser call page
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guestTokenJti" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guestTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guestJoinedAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guestLinkSentAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "call_sessions_guestTokenJti_idx" ON "call_sessions"("guestTokenJti");
