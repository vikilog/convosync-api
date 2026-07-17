/** Conversation assignee — controls which handler processes inbound messages. */
export const CONVERSATION_ASSIGNEE_TYPES = [
  'user',
  'ai',
  'ai_agent',
  'rule_based',
  'journey',
] as const;

export type ConversationAssigneeType = (typeof CONVERSATION_ASSIGNEE_TYPES)[number];

export function isConversationAssigneeType(value: string): value is ConversationAssigneeType {
  return (CONVERSATION_ASSIGNEE_TYPES as readonly string[]).includes(value);
}

export type ConversationAssigneePatch = {
  assigneeType?: ConversationAssigneeType | null;
  assigneeId?: string | null;
  assignedTo?: string | null;
  status?: string;
};
