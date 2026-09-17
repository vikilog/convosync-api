-- Admin-configurable checkout tax rate, by country. Additive — an unconfigured
-- country falls back in resolveTax() to today's exact behavior (18% "GST" for
-- India, 0% for everyone else), so nothing changes until an admin sets a row.

CREATE TABLE IF NOT EXISTS "virtual_number_country_tax" (
    "id" TEXT NOT NULL,
    "countryIso" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "taxLabel" TEXT NOT NULL DEFAULT 'Tax',
    "taxRatePercent" DOUBLE PRECISION NOT NULL,
    "createdByPlatformAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_number_country_tax_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_country_tax_countryIso_key"
    ON "virtual_number_country_tax"("countryIso");
