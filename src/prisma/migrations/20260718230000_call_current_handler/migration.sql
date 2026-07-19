-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN "currentHandler" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "call_sessions" ADD COLUMN "takenOverAt" TIMESTAMP(3);
ALTER TABLE "call_sessions" ADD COLUMN "takenOverByUserId" TEXT;
