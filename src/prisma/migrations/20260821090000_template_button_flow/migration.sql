-- A template's button can now open a WhatsApp Flow (Meta's FLOW button type),
-- which is how a Flow reaches contacts outside the 24h session window
-- (campaigns) — the raw interactive send used elsewhere only works inside it.
ALTER TABLE "Template" ADD COLUMN "buttonFlowId" TEXT;
