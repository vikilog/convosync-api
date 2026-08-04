-- Company (workspace) contact verification timestamps
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);
