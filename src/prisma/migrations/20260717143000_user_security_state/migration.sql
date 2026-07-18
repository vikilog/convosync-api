-- UserSecurityState: durable session versioning (logout-everywhere / password change)
CREATE TABLE IF NOT EXISTS "user_security_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedReason" TEXT,

    CONSTRAINT "user_security_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_security_states_userId_key" ON "user_security_states"("userId");
CREATE INDEX IF NOT EXISTS "user_security_states_userId_idx" ON "user_security_states"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_security_states_userId_fkey'
  ) THEN
    ALTER TABLE "user_security_states"
      ADD CONSTRAINT "user_security_states_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill one row per existing user
INSERT INTO "user_security_states" ("id", "userId", "tokenVersion", "updatedAt", "updatedReason")
SELECT
  'uss_' || replace(gen_random_uuid()::text, '-', ''),
  u."id",
  0,
  CURRENT_TIMESTAMP,
  'backfill'
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "user_security_states" s WHERE s."userId" = u."id"
);
