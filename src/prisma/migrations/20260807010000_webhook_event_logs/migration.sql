-- CreateTable
CREATE TABLE "webhook_event_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "object" TEXT,
    "workspaceId" TEXT,
    "summary" TEXT,
    "payload" JSONB,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_event_logs_receivedAt_idx" ON "webhook_event_logs"("receivedAt");

-- CreateIndex
CREATE INDEX "webhook_event_logs_source_receivedAt_idx" ON "webhook_event_logs"("source", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_event_logs_eventType_idx" ON "webhook_event_logs"("eventType");
