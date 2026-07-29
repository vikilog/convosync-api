-- CreateTable
CREATE TABLE IF NOT EXISTS "SocialListeningPostSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialListeningPostSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SocialListeningPostSetting_workspaceId_postId_key"
  ON "SocialListeningPostSetting"("workspaceId", "postId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SocialListeningPostSetting_workspaceId_idx"
  ON "SocialListeningPostSetting"("workspaceId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SocialListeningPostSetting"
    ADD CONSTRAINT "SocialListeningPostSetting_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
