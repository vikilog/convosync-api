export const JOURNEY_STATUSES = ['draft', 'published'] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const JOURNEY_NODE_TYPES = [
  'TRIGGER',
  'SEND_MESSAGE',
  'ASK_QUESTION',
  'ASSIGN_TO',
  'WAIT',
  'CONDITION',
  'UPDATE_FIELD',
  'WEBHOOK',
  'UPDATE_TAG',
  'OPEN_CONVERSATION',
  'CLOSE_CONVERSATION',
  'TRIGGER_JOURNEY',
  'UPDATE_LIFECYCLE',
  'SEND_CAPI',
  'SEND_TIKTOK',
  'GOOGLE_SHEETS',
  'AI_OBJECTIVE',
  'END',
] as const;
export type JourneyNodeType = (typeof JOURNEY_NODE_TYPES)[number];

export const EXECUTION_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const LOG_STATUSES = ['pending', 'success', 'failed', 'skipped'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

export const EDGE_CONDITIONS = ['yes', 'no', 'default'] as const;
export type EdgeCondition = (typeof EDGE_CONDITIONS)[number];

export const CONDITION_OPERATORS = ['=', '!=', '>', '<', 'contains'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const ANALYTICS_METRICS = ['sent', 'delivered', 'read', 'clicked', 'replied'] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export type TriggerNodeData = {
  event: string;
  filters?: Record<string, unknown>;
};

export type SendMessageNodeData = {
  messageMode?: 'text' | 'template';
  templateName?: string;
  templateId?: string;
  language?: string;
  variables?: Record<string, string> | string[];
  text?: string;
};

export type AskQuestionNodeData = {
  text: string;
  saveReplyTo?: string;
};

export type AssignToNodeData = {
  assigneeType: 'user' | 'ai' | 'rule_based' | 'journey' | 'unassigned';
  assigneeId?: string;
};

export type WaitNodeData = {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
};

export type ConditionNodeData = {
  field: string;
  operator: ConditionOperator;
  value: string | number;
};

export type UpdateFieldNodeData = {
  field: 'name' | 'email' | 'phone' | 'journeyStatus' | 'custom';
  customFieldKey?: string;
  value: string;
};

export type WebhookResponseMapping = {
  /** Dot/bracket path in the JSON response, e.g. `data.accountId` or `items[0].tier` */
  jsonPath: string;
  /** Contact customized attribute key to persist the extracted value */
  attributeKey: string;
};

export type WebhookNodeData = {
  name?: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  timeoutMs?: number;
  retries?: number;
  /** Map response JSON fields into contact custom attributes */
  responseMappings?: WebhookResponseMapping[];
};

export type UpdateTagNodeData = {
  action: 'add' | 'remove' | 'set';
  tags: string[];
};

export type CloseConversationNodeData = {
  closingNote?: string;
};

export type TriggerJourneyNodeData = {
  journeyId: string;
};

export type UpdateLifecycleNodeData = {
  stage: string;
};

export type JourneyGraphNode = {
  id: string;
  type: JourneyNodeType;
  data: Record<string, unknown>;
  positionX: number;
  positionY: number;
};

export type JourneyGraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  conditionValue?: string | null;
};

export type JourneyGraph = {
  nodes: JourneyGraphNode[];
  edges: JourneyGraphEdge[];
};

export type JourneyTriggerPayload = {
  workspaceId: string;
  event: string;
  contactId: string;
  payload?: Record<string, unknown>;
};

export type DelayJobData = {
  executionId: string;
  nextNodeId: string;
  workspaceId: string;
};

export type ExecutionWaitContext = {
  waitKind?: 'delay' | 'reply';
  nextNodeId?: string;
  replyText?: string;
};
