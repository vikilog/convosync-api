-- AlterTable
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "linkGroupId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_linkGroupId_idx" ON "Contact"("workspaceId", "linkGroupId");
