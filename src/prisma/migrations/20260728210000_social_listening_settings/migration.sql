-- CreateTable
CREATE TABLE IF NOT EXISTS "SocialListeningSettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "autoResponseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "interestedMode" TEXT NOT NULL DEFAULT 'review',
    "questionMode" TEXT NOT NULL DEFAULT 'review',
    "complaintMode" TEXT NOT NULL DEFAULT 'review',
    "spamMode" TEXT NOT NULL DEFAULT 'review',
    "confidenceThreshold" INTEGER NOT NULL DEFAULT 80,
    "publicReplyTone" TEXT NOT NULL DEFAULT 'friendly',
    "dmAgentSkillId" TEXT,
    "fallbackMessage" TEXT,
    "leadCreationRule" TEXT NOT NULL DEFAULT 'interested_only',
    "maxAutoDmsPerDay" INTEGER NOT NULL DEFAULT 50,
    "workingHoursOnly" BOOLEAN NOT NULL DEFAULT false,
    "workingHoursStart" TEXT,
    "workingHoursEnd" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialListeningSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SocialListeningSettings_workspaceId_key"
  ON "SocialListeningSettings"("workspaceId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SocialListeningSettings"
    ADD CONSTRAINT "SocialListeningSettings_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
