-- Platform commission/markup on top of a country's base provider cost. Additive —
-- defaults to 0, so every existing row keeps charging exactly monthlyPriceMinor
-- (resell-at-cost) until an admin sets a commission.

ALTER TABLE "virtual_number_pricing" ADD COLUMN IF NOT EXISTS "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
