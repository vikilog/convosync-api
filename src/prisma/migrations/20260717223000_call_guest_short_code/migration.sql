-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "guestShortCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "call_sessions_guestShortCode_key" ON "call_sessions"("guestShortCode");
