/**
 * Strict knowledge-base grounding helpers.
 * Use for low-confidence retrieval, empty context, and post-generation checks.
 */

/**
 * Words that signal "asking about capability in general" (help/can/do, EN + Hinglish),
 * including the "kaam aana" (useful/can help) idiom split across tokens.
 */
const CAPABILITY_SIGNAL_TOKENS = new Set([
  'help', 'madad', 'assist', 'sakte', 'sakta', 'sakti', 'kar', 'kaam', 'kya', 'kaise', 'kis',
  'can', 'what', 'how', 'do',
]);

/** Pronouns/connectors/politeness that carry no topic content — ignored when scoring. */
const CAPABILITY_FILLER_TOKENS = new Set([
  'hi', 'hello', 'hey', 'tum', 'tumse', 'aap', 'aapse', 'mujhe', 'mera', 'meri', 'mere',
  'ho', 'hoon', 'liye', 'tarah', 'overall', 'batao', 'bolo', 'na', 'bhi', 'se', 'aa', 'aana',
  'you', 'for', 'me', 'please', 'kindly', 'and',
]);

const CAPABILITY_ASK_MAX_WORDS = 16;

function capabilityAskTokens(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whole-message soft “what can you do” — not product asks (“what do you offer”,
 * “help me with X”, “WhatsApp connect nahi ho raha”). Token-based rather than a
 * fixed phrase list: natural Hinglish reorders freely ("tum kya kya kar sakte ho",
 * "kis kis tarah se kaam aa sakte ho") and a rigid anchored regex missed those
 * paraphrases entirely, silently escalating a basic "what can you help with"
 * question to human handoff instead of answering it.
 *
 * A message counts as a bare capability ask only when every token is either a
 * capability-signal word or filler — any real topic word (whatsapp, refund,
 * pricing, ...) falls through to normal KB-gated handling, same as before.
 */
export function looksLikeCapabilityAsk(message: string): boolean {
  const tokens = capabilityAskTokens(message.trim());
  if (tokens.length === 0 || tokens.length > CAPABILITY_ASK_MAX_WORDS) return false;

  let hasSignal = false;
  for (const token of tokens) {
    if (CAPABILITY_SIGNAL_TOKENS.has(token)) {
      hasSignal = true;
    } else if (!CAPABILITY_FILLER_TOKENS.has(token)) {
      return false; // real topic content — not a bare capability ask
    }
  }
  return hasSignal;
}

/** Pure hi/bye — LLM often mislabels factual first WhatsApp msgs as greeting. */
function looksLikePureSocial(message: string): boolean {
  return /^(?:hi|hello|hey|hii+|helo|namaste|namaskar|good\s*(?:morning|afternoon|evening)|yo|hola|bye|goodbye|good\s*bye|see\s*you|take\s*care|thanks?(?:\s*(?:bye|goodbye))?|thank\s*you|thx|ok(?:\s*bye)?)(?:\s+there)?[\s!.🙏]*$/i.test(
    message.trim()
  );
}

/** Small talk / media ask — do not require KB match / do not escalate as out-of-scope.
 * Intent-only: stage "greeting" must not skip KB for factual first messages.
 * greeting/farewell skip only for pure social text (not “dasalon kya hai” mislabeled greeting).
 * Optional message: capability asks skip escalate even when intent is general. */
export function isConversationalTurn(
  intent: string,
  _stage?: string,
  message?: string
): boolean {
  if (message && looksLikeCapabilityAsk(message)) return true;
  if (intent === 'human_request' || intent === 'media_request') return true;
  if (intent === 'greeting' || intent === 'farewell') {
    if (!message) return true;
    return looksLikePureSocial(message);
  }
  return false;
}

export const KB_OUT_OF_SCOPE_REPLY =
  'Mujhe iske baare me exact info nahi hai, main aapko team se connect kar deta hu';

/** @deprecated Prefer KB_OUT_OF_SCOPE_REPLY; kept for human_request tone variants. */
export const KB_ESCALATE_REPLY_HUMAN =
  'Bilkul! Main aapko abhi ek human agent se connect karta hun. Thoda wait karein.';

/** Top-of-system-prompt block when no confident KB chunks are available. */
export const KB_NO_MATCH_SYSTEM_PREFIX = `PRIORITY — NO KNOWLEDGE BASE MATCH:
No relevant knowledge base match was found for this query. Do not answer from general/training knowledge. Respond with an out-of-scope fallback message and flag for escalation.
Fallback message: "${KB_OUT_OF_SCOPE_REPLY}"
---
`;

/** Top-of-system-prompt for RAG when chunks are present — still forbids training knowledge. */
export const KB_BOUND_SYSTEM_PREFIX = `PRIORITY — KNOWLEDGE BASE ONLY:
Answer only from MATCHED KNOWLEDGE below. Do not use general/training knowledge.
If MATCHED KNOWLEDGE is empty or does not cover the question: respond with the out-of-scope fallback and flag for escalation.
Fallback message: "${KB_OUT_OF_SCOPE_REPLY}"
---
`;

export type KbOutOfScopeResult = {
  reply: string;
  escalate: true;
  reason: 'no_kb_match' | 'low_confidence' | 'unsupported_generation' | 'off_topic';
};

/** Reusable fallback + escalation flag for no-match / low-score / off-topic / unsupported LLM output. */
export function buildKbOutOfScopeEscalation(
  reason: KbOutOfScopeResult['reason'] = 'no_kb_match',
  reply: string = KB_OUT_OF_SCOPE_REPLY
): KbOutOfScopeResult {
  return { reply, escalate: true, reason };
}

export function filterHitsByMinScore<T extends { score: number }>(
  hits: T[],
  minScore: number
): T[] {
  return hits.filter((h) => h.score >= minScore);
}

const STOP = new Set(
  'a an the is are was were be been being to of in on for with and or but if then so it this that these those i you we they he she my your our their me us him her what which who how when where why can could should would will just please hi hello thanks thank ok yeah yes no not hai hun hu hai kya ke ki ka ko se me mein'.split(
    ' '
  )
);

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));
}

/**
 * Cheap grounding check: reply content tokens should largely appear in KB text.
 * Empty KB → always ungrounded. Escalate-style replies count as grounded (already refusing).
 */
export function isReplyGroundedInKb(reply: string, kbText: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('team se connect') ||
    lower.includes('human agent') ||
    lower.includes('exact info nahi') ||
    lower.includes('connect kar')
  ) {
    return true;
  }

  if (!kbText.trim()) return false;

  const kb = kbText.toLowerCase();
  const tokens = contentTokens(trimmed);
  if (tokens.length === 0) return true; // short/ack with no factual tokens

  let hit = 0;
  for (const t of tokens) {
    if (kb.includes(t)) hit += 1;
  }
  // ponytail: token-overlap heuristic — ceiling on paraphrase-heavy answers; upgrade = LLM judge
  return hit / tokens.length >= 0.35;
}

/** Post-generation guard: replace unsupported answers with out-of-scope escalation. */
export function guardKbBoundReply(params: {
  reply: string;
  kbText: string;
}): { reply: string; replaced: boolean; escalate: boolean; reason?: KbOutOfScopeResult['reason'] } {
  if (isReplyGroundedInKb(params.reply, params.kbText)) {
    return { reply: params.reply, replaced: false, escalate: false };
  }
  const esc = buildKbOutOfScopeEscalation('unsupported_generation');
  return { reply: esc.reply, replaced: true, escalate: true, reason: esc.reason };
}

/**
 * When retrieval already found usable KB, never hand off solely because the
 * cheap token-overlap guard failed (common for Hinglish answers vs English docs).
 * Also overrides model OOS refusals when KB text is present.
 * Prefer a direct KB extract; escalate only if KB text is empty.
 */
export function recoverGroundedKbReply(params: {
  reply: string;
  kbText: string;
  message: string;
  /** Optional FAQ/chunk extractor — injected to avoid hard cycles in tests. */
  extract?: (kbText: string, message: string) => string;
}): { reply: string; replaced: boolean; escalate: boolean; reason?: KbOutOfScopeResult['reason'] } {
  const kb = params.kbText.trim();
  if (!kb) {
    return guardKbBoundReply({ reply: params.reply, kbText: params.kbText });
  }

  const lower = params.reply.trim().toLowerCase();
  const modelRefused =
    !lower ||
    lower.includes('team se connect') ||
    lower.includes('human agent') ||
    lower.includes('exact info nahi') ||
    lower.includes('connect kar');

  if (!modelRefused) {
    const grounded = guardKbBoundReply({ reply: params.reply, kbText: params.kbText });
    if (!grounded.escalate) return grounded;
    // ponytail: Hinglish paraphrase fails token overlap — keep RAG reply when KB was matched
    return { reply: params.reply, replaced: false, escalate: false };
  }

  const extract = params.extract;
  const direct = (extract ? extract(kb, params.message) : kb).trim().slice(0, 900);
  if (!direct) {
    const esc = buildKbOutOfScopeEscalation('unsupported_generation');
    return { reply: esc.reply, replaced: true, escalate: true, reason: esc.reason };
  }

  // Model refused despite usable KB — surface extract instead of handoff.
  return { reply: direct, replaced: true, escalate: false };
}
