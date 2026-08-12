-- Bring-your-own email (AWS SES) per workspace
CREATE TABLE IF NOT EXISTS "workspace_email_configs" (
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'platform',
    "accessKeyIdEncrypted" TEXT,
    "secretAccessKeyEncrypted" TEXT,
    "region" TEXT,
    "senderEmail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_email_configs_pkey" PRIMARY KEY ("workspaceId")
);

DO $$ BEGIN
  ALTER TABLE "workspace_email_configs" ADD CONSTRAINT "workspace_email_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
