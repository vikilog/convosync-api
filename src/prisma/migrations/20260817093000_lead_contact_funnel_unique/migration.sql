-- Double-lead guard: a contact can only have one Lead per funnel. Partial
-- index (contactId is nullable — many leads have no linked contact yet), so
-- this can't be a plain unique constraint; Prisma's schema DSL can't express
-- a filtered index, hence the hand-written SQL. Closes a TOCTOU race in both
-- createLeadFromSocialComment (Instagram comment capture) and
-- upsertLeadForContact (the ADD_TO_FUNNEL journey action), which previously
-- only guarded with a findFirst-then-create check with no DB backing.
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_contact_funnel_unique"
  ON "Lead" ("workspaceId", "contactId", "funnelId")
  WHERE "contactId" IS NOT NULL AND "funnelId" IS NOT NULL;
