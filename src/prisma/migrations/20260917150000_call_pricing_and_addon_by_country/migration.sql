-- Admin-editable per-minute call rate, by country. Additive — an unconfigured
-- country keeps falling back to the live provider pricing-API call (see
-- resolveCallRate() in virtualNumber.helpers.ts).
CREATE TABLE IF NOT EXISTS "virtual_number_call_pricing" (
    "id" TEXT NOT NULL,
    "countryIso" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "baseCostPerMinMinor" DOUBLE PRECISION NOT NULL,
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdByPlatformAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_number_call_pricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_call_pricing_countryIso_key"
    ON "virtual_number_call_pricing"("countryIso");

-- Add-on pricing (recording/transcription/storage) moves from provider-wide to
-- country-wide. Backfill existing rows so nothing goes from "configured" to
-- "falls back to published rate": Plivo only ever served India, so its rows
-- become IN; Telnyx rows (which represented one rate for all of US/GB/SG) become
-- US, then get duplicated into GB and SG so those countries keep the same
-- admin-configured rate they already had.
ALTER TABLE "virtual_number_addon_pricing" ADD COLUMN IF NOT EXISTS "countryIso" TEXT;

UPDATE "virtual_number_addon_pricing" SET "countryIso" = 'IN' WHERE "provider" = 'plivo' AND "countryIso" IS NULL;
UPDATE "virtual_number_addon_pricing" SET "countryIso" = 'US' WHERE "provider" = 'telnyx' AND "countryIso" IS NULL;

INSERT INTO "virtual_number_addon_pricing"
  ("id", "countryIso", "provider", "addOnType", "currency", "ratePerMinMinor", "createdByPlatformAdminId", "createdAt", "updatedAt")
SELECT
  'addon_' || replace(gen_random_uuid()::text, '-', ''),
  gb_sg.iso,
  src."provider",
  src."addOnType",
  src."currency",
  src."ratePerMinMinor",
  src."createdByPlatformAdminId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "virtual_number_addon_pricing" src
CROSS JOIN (VALUES ('GB'), ('SG')) AS gb_sg(iso)
WHERE src."provider" = 'telnyx' AND src."countryIso" = 'US'
  AND NOT EXISTS (
    SELECT 1 FROM "virtual_number_addon_pricing" dup
    WHERE dup."countryIso" = gb_sg.iso AND dup."addOnType" = src."addOnType"
  );

ALTER TABLE "virtual_number_addon_pricing" ALTER COLUMN "countryIso" SET NOT NULL;

DROP INDEX IF EXISTS "virtual_number_addon_pricing_provider_addOnType_key";
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_addon_pricing_countryIso_addOnType_key"
    ON "virtual_number_addon_pricing"("countryIso", "addOnType");
