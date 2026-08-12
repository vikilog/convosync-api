-- AlterTable
ALTER TABLE "LeadFunnelStage" ADD COLUMN IF NOT EXISTS "isFinal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "contactId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lead_contactId_idx" ON "Lead"("contactId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
