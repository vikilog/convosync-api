-- Tracks the most recent reply-routed campaign a contact received, so their
-- next reply can be routed to that campaign's configured journey/AI agent.

ALTER TABLE "Contact" ADD COLUMN "lastCampaignId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "lastCampaignAt" TIMESTAMP(3);
