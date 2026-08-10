-- Resend failed messages: retry counters + status comments (status remains free-form string).
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "email_logs" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;
