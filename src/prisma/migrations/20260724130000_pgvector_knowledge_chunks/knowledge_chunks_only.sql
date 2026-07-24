-- Run as postgres superuser after extension exists.
-- (CREATE EXTENSION is separate — must be done as superuser)

CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "knowledgeItemId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_knowledgeItemId_chunkIndex_key"
  ON "knowledge_chunks"("knowledgeItemId", "chunkIndex");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_workspaceId_agentId_idx"
  ON "knowledge_chunks"("workspaceId", "agentId");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_knowledgeItemId_idx"
  ON "knowledge_chunks"("knowledgeItemId");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_hnsw_idx"
  ON "knowledge_chunks"
  USING hnsw ("embedding" vector_cosine_ops);
