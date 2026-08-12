-- Cache of SES verified sender identities (non-secret) for BYO email settings UI
ALTER TABLE "workspace_email_configs" ADD COLUMN IF NOT EXISTS "verifiedIdentities" JSONB;
ALTER TABLE "workspace_email_configs" ADD COLUMN IF NOT EXISTS "identitiesFetchedAt" TIMESTAMP(3);
