-- Virtual Number (Plivo) request flow: workspace requests access, ConvoSync
-- staff approve via super-admin, workspace picks a number and pays, and only
-- then does the backend actually purchase the number from Plivo.

CREATE TABLE IF NOT EXISTS "virtual_number_requests" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByPlatformAdminId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "selectedNumber" TEXT,
    "selectedCity" TEXT,
    "selectedCountryIso" TEXT,
    "selectedPriceInrPaise" INTEGER,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "plivoNumberId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "purchaseError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_number_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "virtual_number_requests_workspaceId_idx" ON "virtual_number_requests"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "virtual_number_requests_status_idx" ON "virtual_number_requests"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "virtual_number_requests_razorpayOrderId_idx" ON "virtual_number_requests"("razorpayOrderId");

-- AddForeignKey
ALTER TABLE "virtual_number_requests" ADD CONSTRAINT "virtual_number_requests_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
