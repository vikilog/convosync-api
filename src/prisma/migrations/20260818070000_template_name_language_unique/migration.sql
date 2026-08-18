-- Meta's real uniqueness rule for WhatsApp templates is (name, language),
-- not name alone — the same name can have independent approved templates
-- per language. A (workspaceId, name) constraint made that legitimate
-- multi-language rollout impossible locally, and made syncTemplatesFromMeta's
-- upsert key (workspaceId, name) collide two different-language templates
-- that happen to share a name, silently overwriting one with the other.
-- Widening a unique constraint can only make more rows satisfy it, never
-- fewer, so this is safe to apply regardless of existing data.
DROP INDEX IF EXISTS "Template_workspaceId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Template_workspaceId_name_language_key"
  ON "Template" ("workspaceId", "name", "language");
