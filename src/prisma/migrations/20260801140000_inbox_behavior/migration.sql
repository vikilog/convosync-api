-- Inbox Behavior: auto-assignment mode, member eligibility/limits, groups + rules

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "inboxAssignmentMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "inboxAssignmentTimezone" TEXT;

ALTER TABLE "WorkspaceMembership" ADD COLUMN IF NOT EXISTS "autoAssignEligible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WorkspaceMembership" ADD COLUMN IF NOT EXISTS "assignmentLimit" INTEGER;
ALTER TABLE "WorkspaceMembership" ADD COLUMN IF NOT EXISTS "lastAutoAssignedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "InboxTeamGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxTeamGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InboxTeamGroup_workspaceId_idx" ON "InboxTeamGroup"("workspaceId");

CREATE TABLE IF NOT EXISTS "InboxTeamGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxTeamGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InboxTeamGroupMember_groupId_membershipId_key" ON "InboxTeamGroupMember"("groupId", "membershipId");
CREATE INDEX IF NOT EXISTS "InboxTeamGroupMember_membershipId_idx" ON "InboxTeamGroupMember"("membershipId");

CREATE TABLE IF NOT EXISTS "InboxAssignmentRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actionType" TEXT NOT NULL,
    "actionGroupId" TEXT,
    "actionUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxAssignmentRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InboxAssignmentRule_workspaceId_priority_idx" ON "InboxAssignmentRule"("workspaceId", "priority");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxTeamGroup_workspaceId_fkey'
  ) THEN
    ALTER TABLE "InboxTeamGroup"
      ADD CONSTRAINT "InboxTeamGroup_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxTeamGroupMember_groupId_fkey'
  ) THEN
    ALTER TABLE "InboxTeamGroupMember"
      ADD CONSTRAINT "InboxTeamGroupMember_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "InboxTeamGroup"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxTeamGroupMember_membershipId_fkey'
  ) THEN
    ALTER TABLE "InboxTeamGroupMember"
      ADD CONSTRAINT "InboxTeamGroupMember_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMembership"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxAssignmentRule_workspaceId_fkey'
  ) THEN
    ALTER TABLE "InboxAssignmentRule"
      ADD CONSTRAINT "InboxAssignmentRule_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InboxAssignmentRule_actionGroupId_fkey'
  ) THEN
    ALTER TABLE "InboxAssignmentRule"
      ADD CONSTRAINT "InboxAssignmentRule_actionGroupId_fkey"
      FOREIGN KEY ("actionGroupId") REFERENCES "InboxTeamGroup"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
