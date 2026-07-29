/**
 * Run: npx tsx src/services/leadJourney.check.ts
 */
import {
  buildLeadJourneySnapshot,
  mergeLeadJourneyIntoCustomFields,
  parseLeadJourneyFromCustomFields,
} from './leadJourney.js';

const snap = buildLeadJourneySnapshot({
  lead: {
    id: 'lead1',
    funnelId: 'f1',
    stage: 'Won',
    source: 'instagram',
    createdAt: new Date('2026-07-01T10:00:00Z'),
    originUsername: 'jane',
    originCommentText: 'Price?',
    originPostCaption: 'Sale',
  },
  funnelName: 'IG Sales',
  convertedAt: '2026-07-05T12:00:00Z',
  activity: [
    {
      at: '2026-07-01T10:00:00Z',
      type: 'created',
      text: 'Lead created',
    },
    {
      at: '2026-07-03T09:00:00Z',
      type: 'stage_change',
      text: 'Moved from New → Contacted',
      fromStage: 'New',
      toStage: 'Contacted',
    },
    {
      at: '2026-07-05T12:00:00Z',
      type: 'converted',
      text: 'Converted to contact',
    },
  ],
});

console.assert(snap.funnelName === 'IG Sales', 'funnel name');
console.assert(snap.timeline.length === 3, 'timeline length');
console.assert(snap.timeline[0].type === 'created', 'sorted created first');
console.assert(snap.origin?.username === 'jane', 'origin');

const fields = mergeLeadJourneyIntoCustomFields({ ownerId: 'u1' }, snap);
console.assert(typeof fields.leadJourney === 'string', 'stored as string');
console.assert(parseLeadJourneyFromCustomFields(fields)?.leadId === 'lead1', 'roundtrip');

console.log('leadJourney.check.ts: ok');
