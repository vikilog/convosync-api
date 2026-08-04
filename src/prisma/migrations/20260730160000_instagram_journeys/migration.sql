-- Instagram Automation: separate journey tables (not shared with WhatsApp Journey)
CREATE TABLE IF NOT EXISTS "instagram_journeys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "instagram_journeys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "instagram_journey_nodes" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "positionX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "positionY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "instagram_journey_nodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "instagram_journey_edges" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "conditionValue" TEXT,
    CONSTRAINT "instagram_journey_edges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "instagram_journey_executions" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "currentNodeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "context" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastExecutedAt" TIMESTAMP(3),
    CONSTRAINT "instagram_journey_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "instagram_journey_execution_logs" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "nodeId" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "instagram_journey_execution_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "instagram_journeys_workspaceId_idx" ON "instagram_journeys"("workspaceId");
CREATE INDEX IF NOT EXISTS "instagram_journeys_workspaceId_status_idx" ON "instagram_journeys"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "instagram_journey_nodes_journeyId_idx" ON "instagram_journey_nodes"("journeyId");
CREATE INDEX IF NOT EXISTS "instagram_journey_edges_journeyId_idx" ON "instagram_journey_edges"("journeyId");
CREATE INDEX IF NOT EXISTS "instagram_journey_edges_sourceNodeId_idx" ON "instagram_journey_edges"("sourceNodeId");
CREATE INDEX IF NOT EXISTS "instagram_journey_edges_targetNodeId_idx" ON "instagram_journey_edges"("targetNodeId");
CREATE INDEX IF NOT EXISTS "instagram_journey_executions_journeyId_idx" ON "instagram_journey_executions"("journeyId");
CREATE INDEX IF NOT EXISTS "instagram_journey_executions_contactId_idx" ON "instagram_journey_executions"("contactId");
CREATE INDEX IF NOT EXISTS "instagram_journey_executions_status_idx" ON "instagram_journey_executions"("status");
CREATE INDEX IF NOT EXISTS "instagram_journey_executions_journeyId_contactId_idx" ON "instagram_journey_executions"("journeyId", "contactId");
CREATE INDEX IF NOT EXISTS "instagram_journey_execution_logs_executionId_idx" ON "instagram_journey_execution_logs"("executionId");
CREATE INDEX IF NOT EXISTS "instagram_journey_execution_logs_nodeId_idx" ON "instagram_journey_execution_logs"("nodeId");

DO $$ BEGIN
  ALTER TABLE "instagram_journeys" ADD CONSTRAINT "instagram_journeys_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_nodes" ADD CONSTRAINT "instagram_journey_nodes_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "instagram_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_edges" ADD CONSTRAINT "instagram_journey_edges_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "instagram_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_edges" ADD CONSTRAINT "instagram_journey_edges_sourceNodeId_fkey"
    FOREIGN KEY ("sourceNodeId") REFERENCES "instagram_journey_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_edges" ADD CONSTRAINT "instagram_journey_edges_targetNodeId_fkey"
    FOREIGN KEY ("targetNodeId") REFERENCES "instagram_journey_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_executions" ADD CONSTRAINT "instagram_journey_executions_journeyId_fkey"
    FOREIGN KEY ("journeyId") REFERENCES "instagram_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_executions" ADD CONSTRAINT "instagram_journey_executions_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_execution_logs" ADD CONSTRAINT "instagram_journey_execution_logs_executionId_fkey"
    FOREIGN KEY ("executionId") REFERENCES "instagram_journey_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "instagram_journey_execution_logs" ADD CONSTRAINT "instagram_journey_execution_logs_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "instagram_journey_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
