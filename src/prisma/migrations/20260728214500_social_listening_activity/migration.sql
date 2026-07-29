-- CreateTable
CREATE TABLE IF NOT EXISTS "SocialListeningActivity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "relatedCommentId" TEXT,
    "relatedLeadId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialListeningActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SocialListeningActivity_workspaceId_createdAt_idx"
  ON "SocialListeningActivity"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SocialListeningActivity_workspaceId_eventType_createdAt_idx"
  ON "SocialListeningActivity"("workspaceId", "eventType", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SocialListeningActivity"
    ADD CONSTRAINT "SocialListeningActivity_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
