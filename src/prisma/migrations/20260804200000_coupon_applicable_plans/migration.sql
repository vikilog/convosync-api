-- AlterTable
ALTER TABLE "discount_coupons" ADD COLUMN "applicablePlanSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
