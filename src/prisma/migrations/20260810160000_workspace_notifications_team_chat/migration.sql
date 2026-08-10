-- In-app workspace notifications + per-user read state + team chat

CREATE TABLE IF NOT EXISTS "workspace_notifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "actorUserId" TEXT,
    "targetUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_reads" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "team_chat_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "workspace_notifications_workspaceId_createdAt_idx"
  ON "workspace_notifications"("workspaceId", "createdAt");

CREATE INDEX IF NOT EXISTS "workspace_notifications_workspaceId_category_createdAt_idx"
  ON "workspace_notifications"("workspaceId", "category", "createdAt");

CREATE INDEX IF NOT EXISTS "workspace_notifications_workspaceId_actorUserId_createdAt_idx"
  ON "workspace_notifications"("workspaceId", "actorUserId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_reads_notificationId_userId_key"
  ON "notification_reads"("notificationId", "userId");

CREATE INDEX IF NOT EXISTS "notification_reads_userId_readAt_idx"
  ON "notification_reads"("userId", "readAt");

CREATE INDEX IF NOT EXISTS "team_chat_messages_workspaceId_createdAt_idx"
  ON "team_chat_messages"("workspaceId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "workspace_notifications"
    ADD CONSTRAINT "workspace_notifications_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_notifications"
    ADD CONSTRAINT "workspace_notifications_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_notifications"
    ADD CONSTRAINT "workspace_notifications_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notification_reads"
    ADD CONSTRAINT "notification_reads_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "workspace_notifications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notification_reads"
    ADD CONSTRAINT "notification_reads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_messages"
    ADD CONSTRAINT "team_chat_messages_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_messages"
    ADD CONSTRAINT "team_chat_messages_senderUserId_fkey"
    FOREIGN KEY ("senderUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
