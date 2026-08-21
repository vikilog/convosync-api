-- WhatsApp Flow authoring (MVP: navigate-only, raw Meta Flow JSON).
-- Access to the CRUD routes is gated server-side by Workspace.whatsappFlowsEnabled.
CREATE TABLE "WhatsAppFlow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "flowJson" JSONB NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metaFlowId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppFlow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppFlow_workspaceId_name_key" ON "WhatsAppFlow"("workspaceId", "name");
CREATE INDEX "WhatsAppFlow_workspaceId_idx" ON "WhatsAppFlow"("workspaceId");

ALTER TABLE "WhatsAppFlow" ADD CONSTRAINT "WhatsAppFlow_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
