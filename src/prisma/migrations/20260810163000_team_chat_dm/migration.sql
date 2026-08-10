-- Team chat v1: workspace broadcast → 1:1 DMs.
-- Existing broadcast rows have no recipient; drop them (unused / not migratable).

DELETE FROM "team_chat_messages";

ALTER TABLE "team_chat_messages" ADD COLUMN IF NOT EXISTS "recipientUserId" TEXT;
ALTER TABLE "team_chat_messages" ADD COLUMN IF NOT EXISTS "dmPairKey" TEXT;

-- Enforce NOT NULL after delete (table empty).
ALTER TABLE "team_chat_messages" ALTER COLUMN "recipientUserId" SET NOT NULL;
ALTER TABLE "team_chat_messages" ALTER COLUMN "dmPairKey" SET NOT NULL;

DROP INDEX IF EXISTS "team_chat_messages_workspaceId_createdAt_idx";

CREATE INDEX IF NOT EXISTS "team_chat_messages_workspaceId_dmPairKey_createdAt_idx"
  ON "team_chat_messages"("workspaceId", "dmPairKey", "createdAt");

CREATE INDEX IF NOT EXISTS "team_chat_messages_workspaceId_recipientUserId_createdAt_idx"
  ON "team_chat_messages"("workspaceId", "recipientUserId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "team_chat_messages"
    ADD CONSTRAINT "team_chat_messages_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
