-- DropForeignKey
ALTER TABLE "wa_personal_sessions" DROP CONSTRAINT "wa_personal_sessions_workspaceId_fkey";

-- DropIndex
DROP INDEX "Conversation_workspaceId_provider_channelAccountId_idx";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "isArchived",
DROP COLUMN "isPinned",
DROP COLUMN "phoneNumber",
DROP COLUMN "provider";

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "provider";

-- DropTable
DROP TABLE "wa_personal_sessions";

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_channelAccountId_idx" ON "Conversation"("workspaceId", "channelAccountId");
