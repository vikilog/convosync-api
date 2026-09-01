-- Per-contact automation kill switch, toggled from the contact detail card.
-- No journey (WhatsApp or Instagram) trigger/resume may run for a contact while set.

ALTER TABLE "Contact" ADD COLUMN "automationsPaused" BOOLEAN NOT NULL DEFAULT false;
