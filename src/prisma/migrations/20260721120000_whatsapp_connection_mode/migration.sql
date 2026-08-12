-- AlterTable
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "connectionMode" TEXT NOT NULL DEFAULT 'business_api';
