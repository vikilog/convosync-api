-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "linkGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Contact_workspaceId_linkGroupId_idx" ON "Contact"("workspaceId", "linkGroupId");
