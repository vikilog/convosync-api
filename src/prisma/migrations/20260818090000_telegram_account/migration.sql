-- CreateTable
CREATE TABLE "TelegramAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "botUsername" TEXT,
    "botName" TEXT,
    "botToken" TEXT NOT NULL,
    "webhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramAccount_workspaceId_idx" ON "TelegramAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "TelegramAccount_botId_idx" ON "TelegramAccount"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_workspaceId_botId_key" ON "TelegramAccount"("workspaceId", "botId");

-- AddForeignKey
ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

