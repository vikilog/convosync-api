-- Platform-miss template + user/callee-miss auto-reply (text or template).

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "missedCallTemplateId" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "userMissedCallAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "userMissedCallMessage" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "userMissedCallTemplateId" TEXT;
