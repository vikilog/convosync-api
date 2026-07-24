/** Inbox conversation handover / lifecycle events. */
export const CONVERSATION_EVENT_TYPES = [
  'AI_ASSIGNED',
  'AI_HANDLING_STARTED',
  'HUMAN_TAKEOVER',
  'HUMAN_RELEASED_TO_AI',
  'CONVERSATION_RESOLVED',
  'CONVERSATION_REOPENED',
] as const;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export const CONVERSATION_EVENT_ACTOR_TYPES = ['AI_AGENT', 'HUMAN', 'SYSTEM'] as const;

export type ConversationEventActorType = (typeof CONVERSATION_EVENT_ACTOR_TYPES)[number];

export function isAiAssigneeType(type: string | null | undefined): boolean {
  return type === 'ai' || type === 'ai_agent';
}
