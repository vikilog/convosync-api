-- DropForeignKey
ALTER TABLE IF EXISTS "wa_personal_sessions" DROP CONSTRAINT IF EXISTS "wa_personal_sessions_workspaceId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Conversation_workspaceId_provider_channelAccountId_idx";

-- AlterTable
ALTER TABLE IF EXISTS "Conversation" DROP COLUMN IF EXISTS "isArchived",
DROP COLUMN IF EXISTS "isPinned",
DROP COLUMN IF EXISTS "phoneNumber",
DROP COLUMN IF EXISTS "provider";

-- AlterTable
ALTER TABLE IF EXISTS "Message" DROP COLUMN IF EXISTS "provider";

-- DropTable
DROP TABLE IF EXISTS "wa_personal_sessions";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_channelAccountId_idx" ON "Conversation"("workspaceId", "channelAccountId");
