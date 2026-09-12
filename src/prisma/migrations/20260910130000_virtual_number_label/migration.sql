-- User-given label per number, so a workspace can tell multiple numbers apart.

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "label" TEXT;
