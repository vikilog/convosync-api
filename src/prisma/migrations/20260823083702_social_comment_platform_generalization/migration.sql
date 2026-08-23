-- AlterTable
ALTER TABLE "SocialComment" ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'instagram',
ALTER COLUMN "socialAccountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "SocialComment_workspaceId_platform_idx" ON "SocialComment"("workspaceId", "platform");
