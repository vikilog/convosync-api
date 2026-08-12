-- Razorpay Subscription plan IDs for fixed USD catalog prices.
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "razorpayPlanIdMonthlyUsd" TEXT;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "razorpayPlanIdAnnualUsd" TEXT;
