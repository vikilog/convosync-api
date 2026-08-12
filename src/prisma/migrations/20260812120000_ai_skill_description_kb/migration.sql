-- AiSkill: optional description + linked knowledge item IDs for scoped retrieval
ALTER TABLE "AiSkill" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "AiSkill" ADD COLUMN IF NOT EXISTS "knowledgeItemIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
