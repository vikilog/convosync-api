-- Activity feed vs notifications bell: forBell gates the inbox/socket.
ALTER TABLE "workspace_notifications"
  ADD COLUMN IF NOT EXISTS "forBell" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows were alert-style emits — keep them in the bell.
UPDATE "workspace_notifications" SET "forBell" = true;

CREATE INDEX IF NOT EXISTS "workspace_notifications_workspaceId_forBell_createdAt_idx"
  ON "workspace_notifications"("workspaceId", "forBell", "createdAt");
