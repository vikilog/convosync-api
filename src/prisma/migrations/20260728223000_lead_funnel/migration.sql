-- Lead funnels: board containers (no auto-create).
CREATE TABLE IF NOT EXISTS "LeadFunnel" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "goal" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadFunnel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadFunnel_workspaceId_idx" ON "LeadFunnel"("workspaceId");

DO $$ BEGIN
  ALTER TABLE "LeadFunnel"
    ADD CONSTRAINT "LeadFunnel_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "funnelId" TEXT;

CREATE INDEX IF NOT EXISTS "Lead_funnelId_stage_idx" ON "Lead"("funnelId", "stage");

DO $$ BEGIN
  ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_funnelId_fkey"
    FOREIGN KEY ("funnelId") REFERENCES "LeadFunnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "SocialListeningSettings" ADD COLUMN IF NOT EXISTS "leadFunnelId" TEXT;

DO $$ BEGIN
  ALTER TABLE "SocialListeningSettings"
    ADD CONSTRAINT "SocialListeningSettings_leadFunnelId_fkey"
    FOREIGN KEY ("leadFunnelId") REFERENCES "LeadFunnel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
