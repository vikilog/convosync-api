-- AlterTable Contact
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "excludeFromInsights" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_excludeFromInsights_idx"
  ON "Contact"("workspaceId", "excludeFromInsights");

-- AlterTable contact_insights — nullable scores + genuine flag
ALTER TABLE "contact_insights" ADD COLUMN IF NOT EXISTS "isGenuineCustomerInteraction" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "contact_insights" ALTER COLUMN "healthScore" DROP NOT NULL;
ALTER TABLE "contact_insights" ALTER COLUMN "churnRiskScore" DROP NOT NULL;
ALTER TABLE "contact_insights" ALTER COLUMN "purchaseIntentScore" DROP NOT NULL;
ALTER TABLE "contact_insights" ALTER COLUMN "sentimentScore" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "contact_insights_workspaceId_isGenuineCustomerInteraction_idx"
  ON "contact_insights"("workspaceId", "isGenuineCustomerInteraction");
