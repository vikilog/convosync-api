-- Lets Platform Admin act directly on the workspace behind an in-app support
-- request (e.g. whatsapp_flow_request) instead of parsing the message text.
ALTER TABLE "support_requests" ADD COLUMN "workspaceId" TEXT;
