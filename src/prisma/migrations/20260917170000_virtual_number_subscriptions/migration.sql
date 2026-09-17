-- Virtual number rental switches from a one-time Razorpay Order to a real recurring
-- Razorpay Subscription. Additive — existing rows keep their razorpayOrderId untouched.
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "razorpaySubscriptionId" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "razorpayCustomerId" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_requests_razorpaySubscriptionId_key"
    ON "virtual_number_requests"("razorpaySubscriptionId");

-- Caches one Razorpay Plan per exact monthly-rental price point (currency + amount),
-- created lazily on first checkout at that price — see resolveRentalPlanId() in
-- virtualNumber.ts.
CREATE TABLE IF NOT EXISTS "virtual_number_rental_plans" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "razorpayPlanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_number_rental_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "virtual_number_rental_plans_currency_amountMinor_key"
    ON "virtual_number_rental_plans"("currency", "amountMinor");
