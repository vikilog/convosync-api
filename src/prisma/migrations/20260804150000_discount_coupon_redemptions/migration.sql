-- CreateTable
CREATE TABLE "discount_coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "discountAmountPaise" INTEGER NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discount_coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discount_coupon_redemptions_invoiceId_key" ON "discount_coupon_redemptions"("invoiceId");

-- CreateIndex
CREATE INDEX "discount_coupon_redemptions_couponId_idx" ON "discount_coupon_redemptions"("couponId");

-- CreateIndex
CREATE INDEX "discount_coupon_redemptions_workspaceId_idx" ON "discount_coupon_redemptions"("workspaceId");

-- CreateIndex
CREATE INDEX "discount_coupon_redemptions_couponId_workspaceId_idx" ON "discount_coupon_redemptions"("couponId", "workspaceId");

-- AddForeignKey
ALTER TABLE "discount_coupon_redemptions" ADD CONSTRAINT "discount_coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "discount_coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_coupon_redemptions" ADD CONSTRAINT "discount_coupon_redemptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
