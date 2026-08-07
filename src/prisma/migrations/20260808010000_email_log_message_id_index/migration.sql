-- Correlate Resend/SES webhook events by provider message id.
CREATE INDEX IF NOT EXISTS "email_logs_messageId_idx" ON "email_logs"("messageId");
