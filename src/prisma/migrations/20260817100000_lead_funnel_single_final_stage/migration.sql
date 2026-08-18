-- At most one "final" stage per funnel — previously enforced only by a
-- findFirst-then-create/updateMany-then-update check in application code,
-- which two concurrent admin requests could both pass. Partial index
-- (isFinal is usually false), so this can't be a plain unique constraint;
-- Prisma's DSL can't express a filtered index, hence the hand-written SQL.
CREATE UNIQUE INDEX IF NOT EXISTS "LeadFunnelStage_one_final_per_funnel"
  ON "LeadFunnelStage" ("funnelId")
  WHERE "isFinal" = true;
