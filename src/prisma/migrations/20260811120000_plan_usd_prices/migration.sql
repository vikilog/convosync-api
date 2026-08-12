-- Fixed USD subscription prices alongside existing INR fields.
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priceMonthlyUsd" INTEGER;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priceAnnualUsd" INTEGER;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priceMonthlyCents" INTEGER;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priceAnnualCents" INTEGER;
