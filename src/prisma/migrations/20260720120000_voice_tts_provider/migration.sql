-- AlterTable
ALTER TABLE "AiAgent" ADD COLUMN "voiceTtsProvider" TEXT NOT NULL DEFAULT 'cartesia';
ALTER TABLE "AiAgent" ADD COLUMN "voiceTtsVoiceId" TEXT;
