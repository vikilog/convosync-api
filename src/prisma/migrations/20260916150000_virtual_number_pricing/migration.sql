-- Admin-configured virtual number pricing, by country + number type.
-- Additive only — a missing row for a country just falls back to the existing
-- flat priceForType() INR pricing in virtualNumber.helpers.ts.

CREATE TABLE IF NOT EXISTS "virtual_number_pricing" (
    "id" TEXT NOT NULL,
    "countryIso" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "numberType" TEXT NOT NULL DEFAULT 'local',
    "currency" TEXT NOT NULL,
    "monthlyPriceMinor" INTEGER NOT NULL,
    "createdByPlatformAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_number_pricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_pricing_countryIso_numberType_key"
    ON "virtual_number_pricing"("countryIso", "numberType");
