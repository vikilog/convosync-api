/** Pure gate: automation may run only when a leadFunnelId is set. */
export function automationAllowed(leadFunnelId: string | null | undefined): boolean {
  return Boolean(leadFunnelId && leadFunnelId.trim());
}
