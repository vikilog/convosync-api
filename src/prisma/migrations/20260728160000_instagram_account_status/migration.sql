-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "tokenValidatedAt" TIMESTAMP(3);
ALTER TABLE "InstagramAccount" ADD COLUMN IF NOT EXISTS "connectedByUserId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InstagramAccount_status_idx" ON "InstagramAccount"("status");
