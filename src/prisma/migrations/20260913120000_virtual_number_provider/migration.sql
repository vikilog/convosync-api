-- Multi-country calling: route virtual numbers to Plivo (India) or Telnyx (US/GB/SG).
-- Additive only — existing rows default to "plivo" (today's only provider), and the
-- historical plivo* columns are reused for either provider's opaque ids (see schema.prisma).

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'plivo';
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "requirementGroupId" TEXT;
