-- Drop agent-scoped FK / indexes if present (from prior agent MediaAsset)
DROP INDEX IF EXISTS "MediaAsset_workspaceId_agentId_isActive_idx";
DROP INDEX IF EXISTS "MediaAsset_agentId_idx";

DO $$ BEGIN
  ALTER TABLE "MediaAsset" DROP CONSTRAINT IF EXISTS "MediaAsset_agentId_fkey";
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

ALTER TABLE "MediaAsset" DROP COLUMN IF EXISTS "agentId";

-- usage: which product surfaces may consume this asset
ALTER TABLE "MediaAsset" ADD COLUMN IF NOT EXISTS "usage" TEXT[] NOT NULL DEFAULT ARRAY['agent']::TEXT[];

CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_isActive_idx" ON "MediaAsset"("workspaceId", "isActive");
CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_idx" ON "MediaAsset"("workspaceId");
