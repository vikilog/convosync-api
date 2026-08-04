export const IG_JOURNEY_STATUSES = ['draft', 'published'] as const;
export type IgJourneyStatus = (typeof IG_JOURNEY_STATUSES)[number];

/**
 * Instagram automation steps — ManyChat-inspired set that maps to ConvoSync primitives.
 * Story media / sequences / bot fields intentionally omitted (YAGNI / API limits).
 */
export const IG_JOURNEY_NODE_TYPES = [
  'TRIGGER',
  'SEND_MESSAGE',
  'ASK_QUESTION',
  'BUTTONS',
  'WAIT',
  'CONDITION',
  'RANDOMIZER',
  'UPDATE_TAG',
  'UPDATE_FIELD',
  'ADD_TO_FUNNEL',
  'OPEN_CONVERSATION',
  'CLOSE_CONVERSATION',
  'ASSIGN_TO',
  'WEBHOOK',
  'TRIGGER_JOURNEY',
  'GOTO_STEP',
  'END',
] as const;
export type IgJourneyNodeType = (typeof IG_JOURNEY_NODE_TYPES)[number];

export const IG_TRIGGER_EVENTS = [
  { value: 'dm.received', label: 'DM received' },
  { value: 'comment.received', label: 'Comment on post' },
] as const;
export type IgTriggerEvent = (typeof IG_TRIGGER_EVENTS)[number]['value'];

export const CONDITION_OPERATORS = ['=', '!=', '>', '<', 'contains'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type IgTriggerNodeData = {
  /** Legacy single event — still written as events[0] for older clients. */
  event?: IgTriggerEvent;
  /** OR-match: fire if inbound event is any of these. Prefer over `event`. */
  events?: IgTriggerEvent[];
  keyword?: string;
};

const IG_TRIGGER_EVENT_SET = new Set<string>(IG_TRIGGER_EVENTS.map((e) => e.value));

/** Normalize TRIGGER data → unique allowed events (defaults to dm.received). */
export function normalizeIgTriggerEvents(
  data: Pick<IgTriggerNodeData, 'event' | 'events'> | Record<string, unknown> | null | undefined
): IgTriggerEvent[] {
  if (!data || typeof data !== 'object') return ['dm.received'];
  const raw = (data as IgTriggerNodeData).events;
  if (Array.isArray(raw) && raw.length > 0) {
    const out: IgTriggerEvent[] = [];
    for (const e of raw) {
      if (typeof e === 'string' && IG_TRIGGER_EVENT_SET.has(e) && !out.includes(e as IgTriggerEvent)) {
        out.push(e as IgTriggerEvent);
      }
    }
    if (out.length > 0) return out;
  }
  const single = (data as IgTriggerNodeData).event;
  if (typeof single === 'string' && IG_TRIGGER_EVENT_SET.has(single)) {
    return [single as IgTriggerEvent];
  }
  return ['dm.received'];
}

export function triggerAllowsEvent(
  data: Pick<IgTriggerNodeData, 'event' | 'events'> | Record<string, unknown> | null | undefined,
  event: string | null | undefined
): boolean {
  if (!event) return true;
  return normalizeIgTriggerEvents(data).includes(event as IgTriggerEvent);
}

/**
 * "Send as" has exactly 2 modes (Meta constraint, not a UI choice):
 * - private_reply: reply to a comment, delivered as a DM via Meta's comment private-reply
 *   API. Meta only allows text (+ buttons) on this path — no rich media.
 * - window_24h: a regular DM inside the standard customer-service window. Full content
 *   allowed. `'dm'` is the legacy stored value from before this rename and is still
 *   accepted on read (see `resolveIgSendAs`).
 */
export const IG_SEND_AS_MODES = ['private_reply', 'window_24h'] as const;
export type IgSendAsMode = (typeof IG_SEND_AS_MODES)[number];
/** Pre-rename value some saved journeys still have; treated identically to 'window_24h'. */
type LegacyIgSendAsMode = 'dm';

export const IG_SEND_AS_LABELS: Record<IgSendAsMode, string> = {
  private_reply: 'Private Reply',
  window_24h: '24-hour window',
};

export type IgContentBlockButton = { id: string; title: string };

export type IgTextContentBlock = { id: string; type: 'text'; text: string };
export type IgButtonsContentBlock = {
  id: string;
  type: 'buttons';
  text: string;
  buttons: IgContentBlockButton[];
};
/** image/pdf/audio/video all send the same way (Meta needs one fetchable HTTPS URL). */
export type IgMediaContentBlock = {
  id: string;
  type: 'image' | 'pdf' | 'audio' | 'video';
  /** Media Gallery asset id — preferred, reuses existing upload/storage. */
  mediaId?: string;
  /** Direct HTTPS URL fallback; the only option for audio (Media Gallery has no audio type). */
  url?: string;
  caption?: string;
};
export type IgCardElement = {
  title: string;
  subtitle?: string;
  imageMediaId?: string;
  imageUrl?: string;
  /** Single web_url button — generic template postback buttons aren't wired to the flow engine. */
  buttonTitle?: string;
  buttonUrl?: string;
};
export type IgCardContentBlock = IgCardElement & { id: string; type: 'card' };
export type IgGalleryContentBlock = { id: string; type: 'gallery'; cards: IgCardElement[] };
/** No engine send path yet — picker shows these disabled with a "coming soon" badge. */
export type IgComingSoonContentBlock = { id: string; type: 'dynamic' | 'data_collection' };

export type IgContentBlock =
  | IgTextContentBlock
  | IgButtonsContentBlock
  | IgMediaContentBlock
  | IgCardContentBlock
  | IgGalleryContentBlock
  | IgComingSoonContentBlock;

export type IgSendMessageNodeData = {
  /** Legacy single-message text; still the source of truth until `blocks` is set. */
  text: string;
  simulateTyping?: boolean;
  sendAs?: IgSendAsMode | LegacyIgSendAsMode;
  /** Ordered content blocks (the rich picker). Empty/missing ⇒ migrate `text` — see normalizeIgSendMessageBlocks. */
  blocks?: IgContentBlock[];
};

/** Missing/invalid/legacy 'dm' → 'window_24h', matching pre-existing (always-DM) behavior. */
export function resolveIgSendAs(
  data: Pick<IgSendMessageNodeData, 'sendAs'> | Record<string, unknown> | null | undefined
): IgSendAsMode {
  const raw = (data as IgSendMessageNodeData | null)?.sendAs;
  return raw === 'private_reply' ? 'private_reply' : 'window_24h';
}

/**
 * Content blocks a SEND_MESSAGE step could carry. Only 'text' and 'buttons' exist in the
 * builder today — the rest are forward-declared so this allowlist is correct the moment a
 * rich content-block picker lands (ig-journey.types.check.ts covers the rule).
 */
export const IG_CONTENT_BLOCK_TYPES = [
  'text',
  'buttons',
  'image',
  'pdf',
  'audio',
  'video',
  'card',
  'gallery',
  'dynamic',
  'data_collection',
] as const;
export type IgContentBlockType = (typeof IG_CONTENT_BLOCK_TYPES)[number];

const PRIVATE_REPLY_ALLOWED_BLOCKS = new Set<IgContentBlockType>(['text', 'buttons']);

/**
 * Meta constraint: a comment private reply may only contain text (+ buttons); the 24-hour
 * window allows every content block. Accepts a raw/legacy `sendAs` value so callers can pass
 * `local.sendAs` straight from node data without resolving it first.
 */
export function isContentAllowedForSendAs(
  sendAs: IgSendAsMode | LegacyIgSendAsMode | string | null | undefined,
  blockType: IgContentBlockType
): boolean {
  const mode = sendAs === 'private_reply' ? 'private_reply' : 'window_24h';
  return mode !== 'private_reply' || PRIVATE_REPLY_ALLOWED_BLOCKS.has(blockType);
}

const IG_COMING_SOON_BLOCK_TYPES = new Set<IgContentBlockType>(['dynamic', 'data_collection']);

/** True for block types with no engine send path today (Dynamic, Data Collection). */
export function isComingSoonBlockType(blockType: IgContentBlockType): boolean {
  return IG_COMING_SOON_BLOCK_TYPES.has(blockType);
}

function coerceContentBlock(raw: unknown, index: number): IgContentBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !(IG_CONTENT_BLOCK_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  const id = (raw as { id?: unknown }).id;
  return { ...(raw as object), id: typeof id === 'string' && id ? id : `block_${index}`, type } as IgContentBlock;
}

/**
 * Normalize SEND_MESSAGE node data → ordered content blocks. Migrate-on-read: a node saved
 * before the block picker existed only has `text` — treat that as a single text block so old
 * journeys keep rendering/sending exactly as before (see ig-journey.types.check.ts).
 */
export function normalizeIgSendMessageBlocks(
  data: Pick<IgSendMessageNodeData, 'text' | 'blocks'> | Record<string, unknown> | null | undefined
): IgContentBlock[] {
  const d = (data ?? {}) as IgSendMessageNodeData;
  if (Array.isArray(d.blocks) && d.blocks.length > 0) {
    const coerced = d.blocks
      .map((b, i) => coerceContentBlock(b, i))
      .filter((b): b is IgContentBlock => b !== null);
    if (coerced.length > 0) return coerced;
  }
  return [{ id: 'legacy_text', type: 'text', text: typeof d.text === 'string' ? d.text : '' }];
}

/** Blocks this node is actually allowed to execute given its `sendAs` — drops anything Meta would reject. */
export function allowedIgSendMessageBlocks(
  data:
    | Pick<IgSendMessageNodeData, 'text' | 'blocks' | 'sendAs'>
    | Record<string, unknown>
    | null
    | undefined
): IgContentBlock[] {
  const sendAs = resolveIgSendAs(data);
  return normalizeIgSendMessageBlocks(data).filter((b) => isContentAllowedForSendAs(sendAs, b.type));
}

/** Keys always allowed on a SEND_MESSAGE node regardless of `sendAs`. */
const IG_SEND_MESSAGE_BASE_KEYS = new Set(['text', 'simulateTyping', 'sendAs', 'blocks']);

/**
 * Any key beyond text/typing/sendAs/blocks is presumed rich content. Returns the offending
 * keys so callers can reject or strip them for a Private Reply step — a no-op today since the
 * builder never writes extra top-level keys (rich content now lives inside `blocks`, checked
 * separately by `findDisallowedSendMessageBlockTypes`).
 */
export function findDisallowedSendMessageKeys(
  data: Record<string, unknown> | null | undefined
): string[] {
  if (!data || resolveIgSendAs(data) !== 'private_reply') return [];
  return Object.keys(data).filter((key) => !IG_SEND_MESSAGE_BASE_KEYS.has(key));
}

/** Block types a Private Reply step would need stripped before it can publish. */
export function findDisallowedSendMessageBlockTypes(
  data: Record<string, unknown> | null | undefined
): IgContentBlockType[] {
  if (!data || resolveIgSendAs(data) !== 'private_reply') return [];
  return normalizeIgSendMessageBlocks(data)
    .filter((b) => !isContentAllowedForSendAs('private_reply', b.type))
    .map((b) => b.type);
}

/**
 * Private reply is only valid for the first eligible message of a comment-triggered run:
 * builder opted in (`sendAs: 'private_reply'`), the run actually started from a comment,
 * and this run hasn't already spent that comment's one-time private-reply window.
 * Returns the comment id to reply to, or null when a normal DM should be used instead.
 */
export function resolvePrivateReplyCommentId(
  executionContext: Record<string, unknown> | null | undefined,
  data: Pick<IgSendMessageNodeData, 'sendAs'> | Record<string, unknown> | null | undefined
): string | null {
  if (resolveIgSendAs(data) !== 'private_reply') return null;
  const ctx = executionContext ?? {};
  if (ctx.triggerEvent !== 'comment.received') return null;
  if (ctx.privateReplySent) return null;
  const payload = ctx.triggerPayload as Record<string, unknown> | undefined;
  const commentId = typeof payload?.commentId === 'string' ? payload.commentId : null;
  return commentId;
}

export type IgAskQuestionNodeData = {
  text: string;
  quickReplies: Array<{ title: string; payload?: string }>;
  saveReplyTo?: string;
  simulateTyping?: boolean;
  quickCollect?: boolean;
};

export type IgButtonsNodeData = {
  text: string;
  buttons: Array<{ id: string; title: string }>;
  simulateTyping?: boolean;
};

export type IgRandomizerNodeData = {
  paths: Array<{ id: string; label?: string; weight: number }>;
};

export type IgWaitNodeData = {
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
  businessHours?: {
    enabled?: boolean;
    startTime?: string;
    endTime?: string;
    daysOfWeek?: number[];
  };
};

export type IgGotoStepNodeData = {
  targetNodeId: string;
};

export type IgConditionNodeData = {
  field: string;
  operator: ConditionOperator;
  value: string | number;
};

export type IgUpdateTagNodeData = {
  action: 'add' | 'remove' | 'set';
  tags: string[];
};

export type IgUpdateFieldNodeData = {
  field: 'name' | 'email' | 'phone' | 'journeyStatus' | 'custom';
  customFieldKey?: string;
  value: string;
};

export type IgAddToFunnelNodeData = {
  funnelId: string;
  stageId?: string;
};

export type IgCloseConversationNodeData = {
  closingNote?: string;
};

export type IgAssignToNodeData = {
  assigneeType: 'user' | 'ai' | 'unassigned';
  assigneeId?: string;
};

export type IgWebhookNodeData = {
  name?: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  timeoutMs?: number;
  retries?: number;
};

export type IgTriggerJourneyNodeData = {
  journeyId: string;
};

export type IgJourneyGraphNode = {
  id: string;
  type: IgJourneyNodeType;
  data: Record<string, unknown>;
  positionX: number;
  positionY: number;
};

export type IgJourneyGraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  conditionValue?: string | null;
};

export type IgJourneyGraph = {
  nodes: IgJourneyGraphNode[];
  edges: IgJourneyGraphEdge[];
};

export type IgJourneyTriggerPayload = {
  workspaceId: string;
  event: IgTriggerEvent;
  contactId: string;
  text: string;
  payload?: Record<string, unknown>;
};

export type IgExecutionWaitContext = {
  waitKind?: 'reply' | 'delay' | 'button';
  nextNodeId?: string;
  saveReplyTo?: string;
  buttonNodeId?: string;
  /** Idempotency: message mid already used to resume this wait. */
  resumeMessageId?: string;
};

export type IgDelayJobData = {
  executionId: string;
  nextNodeId: string;
  workspaceId: string;
};

export const LOG_STATUSES = ['pending', 'success', 'failed', 'skipped'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

export function matchesKeyword(text: string, keyword: string | undefined | null): boolean {
  const k = keyword?.trim();
  if (!k) return true;
  return text.toLowerCase().includes(k.toLowerCase());
}

export const DEFAULT_IG_NODE_DATA: Record<IgJourneyNodeType, Record<string, unknown>> = {
  TRIGGER: { event: 'dm.received', events: ['dm.received'], keyword: '' },
  SEND_MESSAGE: { text: '', simulateTyping: false },
  ASK_QUESTION: {
    text: '',
    quickReplies: [
      { title: 'Yes', payload: 'yes' },
      { title: 'No', payload: 'no' },
    ],
    saveReplyTo: 'last_reply',
    simulateTyping: false,
    quickCollect: false,
  },
  BUTTONS: {
    text: '',
    buttons: [
      { id: 'btn_a', title: 'Option A' },
      { id: 'btn_b', title: 'Option B' },
    ],
    simulateTyping: false,
  },
  WAIT: {
    amount: 1,
    unit: 'hours',
    businessHours: {
      enabled: false,
      startTime: '08:00',
      endTime: '22:00',
      daysOfWeek: [],
    },
  },
  CONDITION: { field: 'last_reply', operator: '=', value: '' },
  RANDOMIZER: {
    paths: [
      { id: 'a', label: 'Path A', weight: 50 },
      { id: 'b', label: 'Path B', weight: 50 },
    ],
  },
  UPDATE_TAG: { action: 'add', tags: [] },
  UPDATE_FIELD: { field: 'custom', customFieldKey: '', value: '' },
  ADD_TO_FUNNEL: { funnelId: '', stageId: '' },
  OPEN_CONVERSATION: {},
  CLOSE_CONVERSATION: { closingNote: '' },
  ASSIGN_TO: { assigneeType: 'unassigned', assigneeId: '' },
  WEBHOOK: {
    name: '',
    method: 'POST',
    url: '',
    headers: {},
    body: '',
    timeoutMs: 15000,
    retries: 2,
  },
  TRIGGER_JOURNEY: { journeyId: '' },
  GOTO_STEP: { targetNodeId: '' },
  END: {},
};
