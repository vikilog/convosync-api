-- User-defined groups/folders for WhatsApp templates (e.g. "Product", "Service").

CREATE TABLE IF NOT EXISTS "template_groups" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "template_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "template_groups_workspaceId_name_key" ON "template_groups"("workspaceId", "name");
CREATE INDEX IF NOT EXISTS "template_groups_workspaceId_idx" ON "template_groups"("workspaceId");

ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Template_groupId_idx" ON "Template"("groupId");

DO $$ BEGIN
  ALTER TABLE "Template" ADD CONSTRAINT "Template_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "template_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "template_groups" ADD CONSTRAINT "template_groups_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
