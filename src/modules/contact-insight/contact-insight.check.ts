/**
 * ponytail: label format + user message + zod stay coherent.
 * Run: npx tsx src/modules/contact-insight/contact-insight.check.ts
 */
import assert from 'node:assert/strict';
import {
  formatInsightEventLabel,
  formatInsightTimestamp,
} from './contact-insight.context.js';
import {
  buildInsightUserMessage,
  CONTACT_INSIGHT_OPENAI_JSON_SCHEMA,
  CONTACT_INSIGHT_SYSTEM_PROMPT,
} from './contact-insight.llm.js';
import { contactInsightLlmSchema, type InsightContextBundle } from './contact-insight.types.js';

const genuine = contactInsightLlmSchema.parse({
  isGenuineCustomerInteraction: true,
  healthScore: 72,
  churnRiskScore: 35,
  purchaseIntentScore: 80,
  sentimentScore: 40,
  summary: 'Engaged lead, asked about pricing twice.',
  painPoints: ['slow replies'],
  interests: ['pricing', 'demo'],
  recommendedAction: 'Send pricing sheet and book demo',
});
assert.equal(genuine.purchaseIntentScore, 80);

const nonGenuine = contactInsightLlmSchema.parse({
  isGenuineCustomerInteraction: false,
  healthScore: null,
  churnRiskScore: null,
  purchaseIntentScore: null,
  sentimentScore: null,
  summary: 'Looks like internal QA testing, not a customer conversation.',
  painPoints: [],
  interests: [],
  recommendedAction: null,
});
assert.equal(nonGenuine.isGenuineCustomerInteraction, false);

assert.throws(() =>
  contactInsightLlmSchema.parse({
    isGenuineCustomerInteraction: true,
    healthScore: null,
    churnRiskScore: 10,
    purchaseIntentScore: 10,
    sentimentScore: 0,
    summary: 'x',
    painPoints: [],
    interests: [],
    recommendedAction: 'Do something',
  })
);

assert.match(CONTACT_INSIGHT_SYSTEM_PROMPT, /MIXED history/);
assert.equal(
  CONTACT_INSIGHT_OPENAI_JSON_SCHEMA.required.includes('isGenuineCustomerInteraction'),
  true
);

const at = new Date('2026-07-10T14:32:00.000Z');
assert.equal(formatInsightTimestamp(at), '2026-07-10 14:32');
assert.equal(
  formatInsightEventLabel('chat', 'inbound', at),
  '[Chat - inbound - 2026-07-10 14:32]'
);

const analyzedAt = new Date('2026-07-18T06:00:00.000Z');
const bundle: InsightContextBundle = {
  contactId: 'c1',
  workspaceId: 'w1',
  contactName: 'Riya',
  tags: ['Hot', 'Lead'],
  events: [],
  conversationIds: ['conv1'],
  callSessionIds: ['call1'],
  interactionCount: 2,
  earliestAt: new Date('2026-07-01T10:00:00.000Z'),
  latestAt: new Date('2026-07-15T18:00:00.000Z'),
  analyzedAt,
  contextText:
    '[Chat - inbound - 2026-07-01 10:00] Hi\n[Call transcript - inbound - 2026-07-15 18:00] Frustrated about delay',
};

const userMsg = buildInsightUserMessage(bundle);
assert.match(userMsg, /LOW-SIGNAL NOTE/);

console.log('contact-insight.check: ok');
