-- Workspace automation kill switch, default reply, persistent menu
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "automationsPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "defaultReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "defaultReplyText" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "persistentMenu" JSONB;
