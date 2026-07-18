-- CreateTable
CREATE TABLE IF NOT EXISTS "contact_insights" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "healthScore" INTEGER NOT NULL,
    "churnRiskScore" INTEGER NOT NULL,
    "purchaseIntentScore" INTEGER NOT NULL,
    "sentimentScore" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "painPoints" JSONB NOT NULL,
    "interests" JSONB NOT NULL,
    "recommendedAction" TEXT,
    "basedOnConversationIds" JSONB NOT NULL,
    "basedOnCallSessionIds" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "contact_insights_workspaceId_contactId_computedAt_idx"
  ON "contact_insights"("workspaceId", "contactId", "computedAt");

CREATE INDEX IF NOT EXISTS "contact_insights_workspaceId_churnRiskScore_idx"
  ON "contact_insights"("workspaceId", "churnRiskScore");

CREATE INDEX IF NOT EXISTS "contact_insights_workspaceId_purchaseIntentScore_idx"
  ON "contact_insights"("workspaceId", "purchaseIntentScore");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "contact_insights"
    ADD CONSTRAINT "contact_insights_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "contact_insights"
    ADD CONSTRAINT "contact_insights_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
