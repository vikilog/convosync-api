-- CreateTable
CREATE TABLE IF NOT EXISTS "workspace_tags" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_tags_workspaceId_name_key" ON "workspace_tags"("workspaceId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "workspace_tags_workspaceId_folder_idx" ON "workspace_tags"("workspaceId", "folder");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "workspace_tags" ADD CONSTRAINT "workspace_tags_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: one WorkspaceTag row per distinct (workspaceId, tag) already present on contacts.
-- folder is left NULL ("Uncategorized" in the UI) since legacy tags have no folder info.
-- The INSERT below is idempotent (ON CONFLICT DO NOTHING) — if a re-run is ever needed
-- (e.g. contacts were bulk-imported directly into Postgres, bypassing the app), just
-- copy/run this INSERT statement again via `psql "$DATABASE_URL" -c "<statement>"`.
INSERT INTO "workspace_tags" ("id", "workspaceId", "name", "folder", "createdAt", "updatedAt")
SELECT
  'wtag_' || substr(md5(random()::text || clock_timestamp()::text || c."workspaceId" || t.tag), 1, 24),
  c."workspaceId",
  t.tag,
  NULL,
  now(),
  now()
FROM "Contact" c
CROSS JOIN LATERAL unnest(c."tags") AS t(tag)
WHERE t.tag IS NOT NULL AND btrim(t.tag) <> ''
GROUP BY c."workspaceId", t.tag
ON CONFLICT ("workspaceId", "name") DO NOTHING;
