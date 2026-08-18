export const JOURNEY_STATUSES = ['draft', 'published'] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const JOURNEY_NODE_TYPES = [
  'TRIGGER',
  'SEND_MESSAGE',
  'ASK_QUESTION',
  'BUTTONS',
  'ASSIGN_TO',
  'WAIT',
  'CONDITION',
  'RANDOMIZER',
  'UPDATE_FIELD',
  'WEBHOOK',
  'UPDATE_TAG',
  'ADD_TO_FUNNEL',
  'OPEN_CONVERSATION',
  'CLOSE_CONVERSATION',
  'TRIGGER_JOURNEY',
  'GOTO_STEP',
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

/**
 * Condition "kind" — drives which contact attribute a condition row reads and how its
 * value input renders in the builder. `field` is the legacy generic field/operator/value
 * row (free-text field name); every other kind is a friendlier preset over the same shape.
 */
export const CONDITION_TYPES = [
  'field',
  'tag',
  'email_known',
  'phone_known',
  'follows_account',
  'custom_field',
  'channel',
  'journey_status',
  /** Generic "system field" preset — `field` holds a key into resolveSystemField (see condition-evaluator.service). */
  'system_field',
  /** `value` holds a JSON-encoded { startTime, endTime, daysOfWeek } window; checked against workspace-local time. */
  'current_time',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export type Condition = {
  /** Defaults to 'field' when omitted (legacy rows never had a `type`). */
  type?: ConditionType;
  /** Generic field name, custom field key, or unused depending on `type`. */
  field: string;
  operator: ConditionOperator;
  value: string | number;
};

export const DEFAULT_CONDITION: Condition = {
  type: 'field',
  field: 'contact.name',
  operator: 'contains',
  value: '',
};

export type ConditionCombinator = 'all' | 'any';

export const ANALYTICS_METRICS = ['sent', 'delivered', 'read', 'clicked', 'replied'] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export type TriggerNodeData = {
  event: string;
  /** Inbox channels this trigger accepts. Empty/missing = all (backward compatible). */
  channels?: string[];
  filters?: Record<string, unknown>;
};

export const JOURNEY_TRIGGER_CHANNELS = ['whatsapp', 'instagram', 'messenger'] as const;
export type JourneyTriggerChannel = (typeof JOURNEY_TRIGGER_CHANNELS)[number];

/** Empty/missing channels ⇒ all channels (existing journeys keep working). */
export function triggerAllowsChannel(
  data: Pick<TriggerNodeData, 'channels'> | Record<string, unknown> | null | undefined,
  channel: string | null | undefined
): boolean {
  if (!data || typeof data !== 'object') return true;
  const raw = (data as TriggerNodeData).channels;
  if (!Array.isArray(raw) || raw.length === 0) return true;
  if (!channel) return true;
  return raw.includes(channel);
}

export type SendMessageNodeData = {
  messageMode?: 'text' | 'template' | 'cta_url';
  templateName?: string;
  templateId?: string;
  language?: string;
  variables?: Record<string, string> | string[];
  text?: string;
  /** Show channel typing indicator before send (length-based delay). */
  simulateTyping?: boolean;
  /**
   * `cta_url` mode: WhatsApp's `interactive.type: "cta_url"` message — the only Meta-accepted
   * way to attach a link button (WA reply buttons and IG quick replies reject URL types).
   */
  ctaUrl?: string;
  /** Button label shown on the CTA URL message (Meta limit: 20 chars). */
  ctaLabel?: string;
};

export type AskQuestionNodeData = {
  text: string;
  saveReplyTo?: string;
  simulateTyping?: boolean;
  /** UI: compact “data capture” mode — same wait/resume as Ask Question */
  quickCollect?: boolean;
};

export type ButtonsNodeData = {
  text: string;
  /** Max 3 on WhatsApp interactive; each id matches an outgoing edge conditionValue */
  buttons: Array<{ id: string; title: string }>;
  simulateTyping?: boolean;
};

export type RandomizerNodeData = {
  paths: Array<{ id: string; label?: string; weight: number }>;
};

export type AssignToNodeData = {
  assigneeType: 'user' | 'ai' | 'rule_based' | 'journey' | 'unassigned';
  assigneeId?: string;
};

export type WaitNodeData = {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
  /** If enabled, resume only inside this daily window (workspace timezone). */
  businessHours?: {
    enabled?: boolean;
    startTime?: string;
    endTime?: string;
    daysOfWeek?: number[];
  };
};

export type GotoStepNodeData = {
  targetNodeId: string;
};

/** Max same-flow GOTO_STEP hops per execution (infinite-loop guard). */
export const GOTO_STEP_MAX_HOPS = 25;

/**
 * Max synchronous node hops per uninterrupted execution burst (resets on every
 * real pause — WAIT delay, ASK_QUESTION/BUTTONS reply-wait, manual resume).
 * Guards CONDITION/RANDOMIZER cycles, which — unlike GOTO_STEP — have no
 * per-node hop counter of their own and can recurse unbounded in-process.
 */
export const MAX_SYNC_EXECUTION_STEPS = 100;

export type ConditionNodeData = {
  /** Legacy single condition — still written for older clients/back-compat. */
  field?: string;
  operator?: ConditionOperator;
  value?: string | number;
  /** Preferred shape: one or more conditions combined with `combinator`. */
  conditions?: Condition[];
  combinator?: ConditionCombinator;
};

/**
 * Normalize CONDITION node data → a non-empty condition list + combinator.
 * Backward compatible: a lone legacy `{ field, operator, value }` object (no `conditions`
 * array) becomes a 1-item list with combinator `"all"`, so old saved journeys keep evaluating
 * exactly as before.
 */
export function normalizeConditionGroup(
  data: ConditionNodeData | Record<string, unknown> | null | undefined
): { conditions: Condition[]; combinator: ConditionCombinator } {
  const d = (data ?? {}) as ConditionNodeData;
  if (Array.isArray(d.conditions) && d.conditions.length > 0) {
    return {
      conditions: d.conditions,
      combinator: d.combinator === 'any' ? 'any' : 'all',
    };
  }
  if (d.field != null && d.field !== '') {
    return {
      conditions: [
        {
          type: 'field',
          field: d.field,
          operator: d.operator ?? '=',
          value: d.value ?? '',
        },
      ],
      combinator: 'all',
    };
  }
  return { conditions: [], combinator: 'all' };
}

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

export type AddToFunnelNodeData = {
  funnelId: string;
  /** Optional board; defaults to first/"New" stage */
  stageId?: string;
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
  waitKind?: 'delay' | 'reply' | 'button';
  nextNodeId?: string;
  replyText?: string;
  /** BUTTONS node: match inbound payload/text to edge conditionValue */
  buttonNodeId?: string;
};
