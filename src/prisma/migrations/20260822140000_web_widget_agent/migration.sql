-- Website widget answers via a chosen AiAgent's skills + knowledge base
-- (pgvector), not the salon Mongo-sync AI Knowledge system.

ALTER TABLE "WebWidget" ADD COLUMN "agentId" TEXT;
CREATE INDEX "WebWidget_agentId_idx" ON "WebWidget"("agentId");
ALTER TABLE "WebWidget" ADD CONSTRAINT "WebWidget_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
