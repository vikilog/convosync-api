-- Drop orphaned CachedResponse table (cache.service.ts removed; model unused).
-- Review before applying to production: this permanently deletes any rows still in the table.
DROP TABLE IF EXISTS "CachedResponse";
