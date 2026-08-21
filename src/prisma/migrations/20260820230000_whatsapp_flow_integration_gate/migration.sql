-- WhatsApp Flow integration card: no self-serve toggle. A workspace can only
-- request access; we flip whatsappFlowsEnabled by hand after reviewing the
-- request (which also lands in support_requests via the request-access route).
ALTER TABLE "Workspace" ADD COLUMN "whatsappFlowsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "whatsappFlowsRequestedAt" TIMESTAMP(3);
