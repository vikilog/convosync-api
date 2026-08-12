-- AlterTable
ALTER TABLE "AiAgent" ADD COLUMN IF NOT EXISTS "voiceSttProvider" TEXT NOT NULL DEFAULT 'cartesia';
