-- Conversation handover timeline events (AI ↔ human)
CREATE TABLE IF NOT EXISTS "ConversationEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConversationEvent_conversationId_idx" ON "ConversationEvent"("conversationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ConversationEvent_conversationId_fkey'
  ) THEN
    ALTER TABLE "ConversationEvent"
      ADD CONSTRAINT "ConversationEvent_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
