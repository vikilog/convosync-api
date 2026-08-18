-- Atomic reservation counter for SocialListeningPostSetting.maxAutoDmsPerDay.
-- Previously the cap was enforced by reading a live COUNT of already-sent
-- DMs and comparing to the limit, then deciding separately whether to send.
-- Concurrent auto-DM decisions for the same post (e.g. two comments
-- classified moments apart) could all read the same "sent today" count
-- before any of them had actually sent, all pass the check, and all send —
-- overshooting the daily cap. A single per-row counter, incremented via a
-- conditional UPDATE against this exact row, lets Postgres's row-level
-- locking serialize concurrent reservations instead.
ALTER TABLE "SocialListeningPostSetting" ADD COLUMN "autoDmsCounterDate" TIMESTAMP(3);
ALTER TABLE "SocialListeningPostSetting" ADD COLUMN "autoDmsCounterCount" INTEGER NOT NULL DEFAULT 0;
