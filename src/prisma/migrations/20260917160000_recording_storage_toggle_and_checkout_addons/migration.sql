-- Workspace preference toggle for keeping call recordings in storage past the free
-- window. Additive, defaults to off — same "preference only for now" status as
-- transcriptionEnabled; doesn't turn on any billing or recording by itself.
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "recordingStorageEnabled" BOOLEAN NOT NULL DEFAULT false;
