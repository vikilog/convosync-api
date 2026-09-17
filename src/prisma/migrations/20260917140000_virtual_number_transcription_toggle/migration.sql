-- Workspace preference toggle for call transcription. Additive, defaults to off —
-- this column alone does not turn on any billing or recording; it only stores intent
-- ahead of the actual live-call recording + wallet-debit wiring (separate follow-up).

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "transcriptionEnabled" BOOLEAN NOT NULL DEFAULT false;
