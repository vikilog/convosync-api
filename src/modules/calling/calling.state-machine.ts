import {
  type CallStatus,
  TERMINAL_CALL_STATUSES,
} from './calling.types.js';

/**
 * Legal edges for the approved call state machine.
 * Soft decline (P2): declined is only entered via explicit transition from ringing
 * when the service decides no ring targets remain — that policy lives in calling.service.
 */
const ALLOWED: Record<CallStatus, readonly CallStatus[]> = {
  initiated: ['ringing', 'failed', 'ended'],
  ringing: ['accepted', 'declined', 'missed', 'ended', 'failed'],
  accepted: ['connected', 'missed', 'ended', 'failed'],
  connected: ['ended', 'failed'],
  declined: [],
  missed: [],
  ended: [],
  failed: [],
};

export function isTerminalCallStatus(status: CallStatus): boolean {
  return (TERMINAL_CALL_STATUSES as readonly string[]).includes(status);
}

export function canTransitionCallStatus(from: CallStatus, to: CallStatus): boolean {
  if (from === to) return true; // idempotent no-op
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertCallTransition(from: CallStatus, to: CallStatus): void {
  if (!canTransitionCallStatus(from, to)) {
    throw new Error(`Illegal call transition: ${from} → ${to}`);
  }
}
