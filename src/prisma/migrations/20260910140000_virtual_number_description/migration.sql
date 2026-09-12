-- Per-number description, alongside the existing name/label.

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "description" TEXT;
