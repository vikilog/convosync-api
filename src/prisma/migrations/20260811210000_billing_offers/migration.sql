-- Super-admin Razorpay subscription / payment-link offers for tenants.
CREATE TABLE IF NOT EXISTS "billing_offers" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "amountMinor" INTEGER NOT NULL,
    "offerType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "razorpayPlanId" TEXT,
    "razorpaySubscriptionId" TEXT,
    "razorpayPaymentLinkId" TEXT,
    "shortUrl" TEXT,
    "note" TEXT,
    "createdByPlatformAdminId" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "billing_offers_workspaceId_status_idx" ON "billing_offers"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "billing_offers_razorpaySubscriptionId_idx" ON "billing_offers"("razorpaySubscriptionId");
CREATE INDEX IF NOT EXISTS "billing_offers_razorpayPaymentLinkId_idx" ON "billing_offers"("razorpayPaymentLinkId");

ALTER TABLE "billing_offers"
  ADD CONSTRAINT "billing_offers_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_offers"
  ADD CONSTRAINT "billing_offers_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_offers"
  ADD CONSTRAINT "billing_offers_createdByPlatformAdminId_fkey"
  FOREIGN KEY ("createdByPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
