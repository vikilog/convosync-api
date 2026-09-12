/**
 * Convert a Plivo Pricing `rate` into USD per minute.
 * Classic `/Pricing` local.rate is already per-minute. Pulse `rates[]` is per
 * `voice_unit` seconds — only then scale. Missing/0 `voice_unit` used to yield NaN.
 */
export function voiceRatePerMinuteUsd(rate: string | number | null | undefined, voiceUnit?: number | null): number {
  const raw = typeof rate === 'number' ? rate : parseFloat(String(rate ?? ''));
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (typeof voiceUnit === 'number' && Number.isFinite(voiceUnit) && voiceUnit > 0 && voiceUnit !== 60) {
    return (raw * 60) / voiceUnit;
  }
  return raw;
}
