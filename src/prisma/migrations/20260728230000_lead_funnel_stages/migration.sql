-- Per-funnel Kanban boards (columns). Default "New" created in app on funnel create.
CREATE TABLE IF NOT EXISTS "LeadFunnelStage" (
  "id" TEXT NOT NULL,
  "funnelId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadFunnelStage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadFunnelStage_funnelId_position_idx"
  ON "LeadFunnelStage"("funnelId", "position");

DO $$ BEGIN
  ALTER TABLE "LeadFunnelStage"
    ADD CONSTRAINT "LeadFunnelStage_funnelId_fkey"
    FOREIGN KEY ("funnelId") REFERENCES "LeadFunnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "stageId" TEXT;

CREATE INDEX IF NOT EXISTS "Lead_stageId_idx" ON "Lead"("stageId");

DO $$ BEGIN
  ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "LeadFunnelStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Seed default "New" board for existing funnels that have none.
INSERT INTO "LeadFunnelStage" ("id", "funnelId", "name", "position", "createdAt", "updatedAt")
SELECT
  'lfs_' || substr(md5(random()::text || f."id"), 1, 20),
  f."id",
  'New',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "LeadFunnel" f
WHERE NOT EXISTS (
  SELECT 1 FROM "LeadFunnelStage" s WHERE s."funnelId" = f."id"
);

-- Attach orphan leads in a funnel to that funnel's first stage.
UPDATE "Lead" l
SET
  "stageId" = s."id",
  "stage" = s."name"
FROM (
  SELECT DISTINCT ON ("funnelId") "id", "funnelId", "name"
  FROM "LeadFunnelStage"
  ORDER BY "funnelId", "position" ASC, "createdAt" ASC
) s
WHERE l."funnelId" = s."funnelId"
  AND l."stageId" IS NULL;
