-- CreateTable
CREATE TABLE IF NOT EXISTS "MediaAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "filename" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL DEFAULT 'customer',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_agentId_isActive_idx" ON "MediaAsset"("workspaceId", "agentId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaAsset_agentId_idx" ON "MediaAsset"("agentId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
