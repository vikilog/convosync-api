-- Plivo's real recording-storage rate (₹0.032/min/month) isn't a whole number of
-- paise, so the rate column needs decimal precision. "storage" also becomes a valid
-- addOnType value alongside "recording"/"transcription" (no schema constraint change
-- needed for that — addOnType is a plain string).

ALTER TABLE "virtual_number_addon_pricing" ALTER COLUMN "ratePerMinMinor" TYPE DOUBLE PRECISION;
