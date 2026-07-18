-- LiveKit voice call sessions (Phase A)
CREATE TABLE IF NOT EXISTS "call_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "contactId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "livekitRoomSid" TEXT,
    "initiatedByUserId" TEXT,
    "assignedTo" TEXT,
    "acceptedByUserId" TEXT,
    "ringingAt" TIMESTAMP(3),
    "ringingUntil" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "endReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_sessions_roomName_key" ON "call_sessions"("roomName");
CREATE INDEX IF NOT EXISTS "call_sessions_workspaceId_status_idx" ON "call_sessions"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "call_sessions_conversationId_idx" ON "call_sessions"("conversationId");
CREATE INDEX IF NOT EXISTS "call_sessions_workspaceId_assignedTo_status_idx" ON "call_sessions"("workspaceId", "assignedTo", "status");
CREATE INDEX IF NOT EXISTS "call_sessions_workspaceId_createdAt_idx" ON "call_sessions"("workspaceId", "createdAt");

CREATE TABLE IF NOT EXISTS "call_participants" (
    "id" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "userId" TEXT,
    "contactId" TEXT,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_participants_callSessionId_identity_key" ON "call_participants"("callSessionId", "identity");
CREATE INDEX IF NOT EXISTS "call_participants_callSessionId_idx" ON "call_participants"("callSessionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_workspaceId_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_conversationId_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_contactId_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_initiatedByUserId_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_initiatedByUserId_fkey"
      FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_assignedTo_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_assignedTo_fkey"
      FOREIGN KEY ("assignedTo") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_acceptedByUserId_fkey') THEN
    ALTER TABLE "call_sessions"
      ADD CONSTRAINT "call_sessions_acceptedByUserId_fkey"
      FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_participants_callSessionId_fkey') THEN
    ALTER TABLE "call_participants"
      ADD CONSTRAINT "call_participants_callSessionId_fkey"
      FOREIGN KEY ("callSessionId") REFERENCES "call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_participants_userId_fkey') THEN
    ALTER TABLE "call_participants"
      ADD CONSTRAINT "call_participants_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_participants_contactId_fkey') THEN
    ALTER TABLE "call_participants"
      ADD CONSTRAINT "call_participants_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
