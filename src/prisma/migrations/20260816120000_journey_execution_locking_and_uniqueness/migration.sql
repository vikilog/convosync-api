-- Optimistic locking: version column bumped on every updateProgress write,
-- so a concurrent resume/delay-continuation racing on the same execution
-- can detect and reject a stale-based update instead of silently losing it.
ALTER TABLE "JourneyExecution" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "instagram_journey_executions" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- Double-enrollment guard: a contact can only have one active (running/waiting)
-- execution per journey at a time. Partial index — a contact can freely be
-- re-enrolled once their prior run reaches completed/failed/cancelled, so this
-- can't be a plain (journeyId, contactId) unique constraint. Prisma's schema
-- DSL can't express a filtered index, hence the hand-written SQL.
CREATE UNIQUE INDEX IF NOT EXISTS "JourneyExecution_active_enrollment_unique"
  ON "JourneyExecution" ("journeyId", "contactId")
  WHERE status IN ('running', 'waiting');

CREATE UNIQUE INDEX IF NOT EXISTS "instagram_journey_executions_active_enrollment_unique"
  ON "instagram_journey_executions" ("journeyId", "contactId")
  WHERE status IN ('running', 'waiting');
