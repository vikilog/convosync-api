-- Number settings: release tracking + missed-call auto-reply configuration.

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "missedCallAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "missedCallMessage" TEXT;
