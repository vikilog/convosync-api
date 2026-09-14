-- Local call-log storage for Telnyx-routed numbers, fed by real-time webhooks —
-- Telnyx's own Detail Record Search API has been unreliable (persistent 500s observed
-- live), so we stop depending on it for the call-log list/detail UI.

CREATE TABLE IF NOT EXISTS "telnyx_call_logs" (
  "id" TEXT NOT NULL,
  "callUuid" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "fromNumber" TEXT NOT NULL,
  "toNumber" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "callState" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "startTime" TIMESTAMP(3),
  "endTime" TIMESTAMP(3),
  "hangupCause" TEXT,
  "recordUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "telnyx_call_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telnyx_call_logs_callUuid_key" ON "telnyx_call_logs"("callUuid");
CREATE INDEX IF NOT EXISTS "telnyx_call_logs_workspaceId_idx" ON "telnyx_call_logs"("workspaceId");
CREATE INDEX IF NOT EXISTS "telnyx_call_logs_startTime_idx" ON "telnyx_call_logs"("startTime");
