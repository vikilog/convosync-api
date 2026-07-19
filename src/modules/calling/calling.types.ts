/** Call lifecycle statuses — see state machine in product docs / Phase A review. */
export const CALL_STATUSES = [
  'initiated',
  'ringing',
  'accepted',
  'connected',
  'declined',
  'missed',
  'ended',
  'failed',
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_PARTICIPANT_ROLES = ['customer', 'agent', 'ai', 'sip'] as const;
export type CallParticipantRole = (typeof CALL_PARTICIPANT_ROLES)[number];

export const ACTIVE_CALL_STATUSES: CallStatus[] = [
  'initiated',
  'ringing',
  'accepted',
  'connected',
];

export const TERMINAL_CALL_STATUSES: CallStatus[] = [
  'declined',
  'missed',
  'ended',
  'failed',
];

/** Socket.IO event names (signaling only — no media). */
export const CALL_SOCKET_EVENTS = {
  initiated: 'call_initiated',
  incoming: 'incoming_call',
  accepted: 'call_accepted',
  declined: 'call_declined',
  connected: 'call_connected',
  ended: 'call_ended',
  missed: 'call_missed',
  failed: 'call_failed',
  participantJoined: 'call_participant_joined',
  participantLeft: 'call_participant_left',
  reconnect: 'call_reconnect',
  handlerChanged: 'call_handler_changed',
  transcriptChunk: 'call_transcript_chunk',
} as const;

export type CallTransitionRecord = {
  at: string;
  from: CallStatus;
  to: CallStatus;
  reason?: string;
  byUserId?: string;
};

export class CallingError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'CallingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
