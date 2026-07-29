-- AlterTable
ALTER TABLE "SocialComment" ADD COLUMN IF NOT EXISTS "leadId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Lead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "source" TEXT NOT NULL DEFAULT 'instagram',
    "requirement" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "originUsername" TEXT,
    "originCommentText" TEXT,
    "originPostThumbnailUrl" TEXT,
    "originPostCaption" TEXT,
    "originCommentedAt" TIMESTAMP(3),
    "activity" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SocialComment_leadId_key" ON "SocialComment"("leadId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_stage_idx" ON "Lead"("workspaceId", "stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_source_idx" ON "Lead"("workspaceId", "source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_workspaceId_createdAt_idx" ON "Lead"("workspaceId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
