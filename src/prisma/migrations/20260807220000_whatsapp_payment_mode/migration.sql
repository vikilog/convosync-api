-- AlterTable
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "paymentMode" TEXT;
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "hasOwnMetaPaymentMethod" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "paymentConfigCheckedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppPhoneAccount" ADD COLUMN IF NOT EXISTS "metaBusinessId" TEXT;
