-- Run as postgres superuser after extension exists.
-- (CREATE EXTENSION is separate — must be done as superuser)
-- Same idempotent guards as migration.sql (db-push bare vector → vector(1536) → HNSW).

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'knowledge_chunks'
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
      AND t.typname = 'vector'
      AND a.atttypmod <> 1536
  ) THEN
    EXECUTE $sql$
      ALTER TABLE "knowledge_chunks"
        ALTER COLUMN "embedding" TYPE vector(1536)
        USING ("embedding"::vector(1536))
    $sql$;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_knowledgeItemId_chunkIndex_key"
  ON "knowledge_chunks"("knowledgeItemId", "chunkIndex");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_workspaceId_agentId_idx"
  ON "knowledge_chunks"("workspaceId", "agentId");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_knowledgeItemId_idx"
  ON "knowledge_chunks"("knowledgeItemId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'knowledge_chunks'
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
      AND t.typname = 'vector'
      AND a.atttypmod = 1536
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class idx
    JOIN pg_namespace n ON idx.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND idx.relname = 'knowledge_chunks_embedding_hnsw_idx'
  ) THEN
    EXECUTE $sql$
      CREATE INDEX "knowledge_chunks_embedding_hnsw_idx"
        ON "knowledge_chunks"
        USING hnsw ("embedding" vector_cosine_ops)
    $sql$;
  END IF;
END $$;
