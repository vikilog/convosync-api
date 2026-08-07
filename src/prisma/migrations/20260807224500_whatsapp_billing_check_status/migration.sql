-- AlterTable
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "billingCheckStatus" TEXT;
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "paymentSetupAcknowledgedAt" TIMESTAMP(3);
