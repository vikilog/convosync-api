-- Tracks the flow_token generated for each outbound WhatsApp Flow send so the
-- completion webhook (which only carries the token, never the flow's identity —
-- Meta's nfm_reply.name is always the fixed string "flow") can be traced back
-- to the WhatsAppFlow it belongs to.

CREATE TABLE "WhatsAppFlowSend" (
    "flowToken" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppFlowSend_pkey" PRIMARY KEY ("flowToken")
);

CREATE INDEX "WhatsAppFlowSend_flowId_idx" ON "WhatsAppFlowSend"("flowId");

CREATE INDEX "WhatsAppFlowSend_workspaceId_idx" ON "WhatsAppFlowSend"("workspaceId");

ALTER TABLE "WhatsAppFlowSend" ADD CONSTRAINT "WhatsAppFlowSend_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "WhatsAppFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
