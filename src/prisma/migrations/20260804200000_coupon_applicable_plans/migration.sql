-- AlterTable
ALTER TABLE "discount_coupons" ADD COLUMN IF NOT EXISTS "applicablePlanSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
