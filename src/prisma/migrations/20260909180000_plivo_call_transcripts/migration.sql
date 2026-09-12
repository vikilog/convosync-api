-- Async transcript delivered by Plivo's <Record transcriptionUrl> callback,
-- keyed by call_uuid rather than a workspace FK (call_uuid is globally unique).

CREATE TABLE IF NOT EXISTS "plivo_call_transcripts" (
    "id" TEXT NOT NULL,
    "callUuid" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plivo_call_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "plivo_call_transcripts_callUuid_key" ON "plivo_call_transcripts"("callUuid");
