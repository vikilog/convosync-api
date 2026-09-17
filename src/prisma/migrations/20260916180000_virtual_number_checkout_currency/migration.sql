-- Multi-currency checkout for virtual numbers, plus admin-editable add-on
-- (recording/transcription) reference pricing. Additive only:
--   * selectedPriceInrPaise is untouched — still populated for INR selections.
--   * selectedCurrency defaults to 'INR' so every existing row keeps behaving
--     exactly as it did before this column existed.

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "selectedPriceMinor" INTEGER;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "selectedCurrency" TEXT NOT NULL DEFAULT 'INR';

-- Backfill: every pre-existing selection was INR-only, so selectedPriceMinor is just
-- a copy of selectedPriceInrPaise for rows that already picked a number.
UPDATE "virtual_number_requests"
SET "selectedPriceMinor" = "selectedPriceInrPaise"
WHERE "selectedPriceInrPaise" IS NOT NULL AND "selectedPriceMinor" IS NULL;

CREATE TABLE IF NOT EXISTS "virtual_number_addon_pricing" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "addOnType" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ratePerMinMinor" INTEGER NOT NULL,
    "createdByPlatformAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_number_addon_pricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_addon_pricing_provider_addOnType_key"
    ON "virtual_number_addon_pricing"("provider", "addOnType");
