-- Embeddable AI chat widget per workspace: a public token authenticates the
-- embed script against a scoped chat endpoint, nothing else in the workspace.

CREATE TABLE "WebWidget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "botName" TEXT NOT NULL DEFAULT 'Assistant',
    "greeting" TEXT NOT NULL DEFAULT 'Hi! How can I help you today?',
    "accentColor" TEXT NOT NULL DEFAULT '#16a34a',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebWidget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebWidget_workspaceId_key" ON "WebWidget"("workspaceId");
CREATE UNIQUE INDEX "WebWidget_token_key" ON "WebWidget"("token");

ALTER TABLE "WebWidget" ADD CONSTRAINT "WebWidget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
