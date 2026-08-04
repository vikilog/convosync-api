/**
 * Run: npx tsx src/modules/journey/services/condition-evaluator.service.check.ts
 */
import assert from 'node:assert/strict';
import type { Contact } from '@prisma/client';
import { evaluateCondition, pickBranchEdge } from './condition-evaluator.service.ts';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1',
    name: 'Sam',
    phone: '+15551234567',
    email: null,
    avatar: null,
    source: null,
    tags: [],
    customFields: null,
    journeyStatus: null,
    linkGroupId: null,
    excludeFromInsights: false,
    workspaceId: 'w1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Contact;
}

async function run() {
  // Legacy single-condition object still evaluates exactly as before.
  const legacyContact = makeContact({ name: 'Samantha' });
  assert.equal(
    await evaluateCondition(legacyContact, { field: 'contact.name', operator: 'contains', value: 'sam' }),
    true
  );
  assert.equal(
    await evaluateCondition(legacyContact, { field: 'contact.name', operator: 'contains', value: 'zzz' }),
    false
  );

  // combinator "all" (AND) — every condition must match.
  const vip = makeContact({ tags: ['vip', 'newsletter'], email: 'a@b.com' });
  const allMatch = await evaluateCondition(vip, {
    combinator: 'all',
    conditions: [
      { type: 'tag', field: '', operator: '=', value: 'vip' },
      { type: 'email_known', field: '', operator: '=', value: 'yes' },
    ],
  });
  assert.equal(allMatch, true);
  const allNoMatch = await evaluateCondition(vip, {
    combinator: 'all',
    conditions: [
      { type: 'tag', field: '', operator: '=', value: 'vip' },
      { type: 'tag', field: '', operator: '=', value: 'nope' },
    ],
  });
  assert.equal(allNoMatch, false);

  // combinator "any" (OR) — one match is enough.
  const anyMatch = await evaluateCondition(vip, {
    combinator: 'any',
    conditions: [
      { type: 'tag', field: '', operator: '=', value: 'nope' },
      { type: 'tag', field: '', operator: '=', value: 'vip' },
    ],
  });
  assert.equal(anyMatch, true);

  // Tag "doesn't have" via !=
  assert.equal(
    await evaluateCondition(vip, { conditions: [{ type: 'tag', field: '', operator: '!=', value: 'nope' }] }),
    true
  );

  // custom_field + journey_status + channel presets
  const custom = makeContact({
    customFields: { plan: 'pro' },
    journeyStatus: 'active',
    phone: 'ig:12345',
  });
  assert.equal(
    await evaluateCondition(custom, {
      conditions: [{ type: 'custom_field', field: 'plan', operator: '=', value: 'pro' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(custom, {
      conditions: [{ type: 'journey_status', field: '', operator: '=', value: 'active' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(custom, {
      conditions: [{ type: 'channel', field: '', operator: '=', value: 'instagram' }],
    }),
    true
  );

  // phone_known: real WA number → known; ig:/fb: synthetic id → not known.
  assert.equal(
    await evaluateCondition(makeContact({ phone: '+15551234567' }), {
      conditions: [{ type: 'phone_known', field: '', operator: '=', value: 'yes' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(makeContact({ phone: 'ig:99999' }), {
      conditions: [{ type: 'phone_known', field: '', operator: '=', value: 'yes' }],
    }),
    false
  );

  // follows_account: no ctx (e.g. WhatsApp) → fail-closed false, never throws.
  assert.equal(
    await evaluateCondition(makeContact({ phone: 'ig:99999' }), {
      conditions: [{ type: 'follows_account', field: '', operator: '=', value: 'yes' }],
    }),
    false
  );
  // follows_account: injected checker drives the result.
  assert.equal(
    await evaluateCondition(
      makeContact({ phone: 'ig:99999' }),
      { conditions: [{ type: 'follows_account', field: '', operator: '=', value: 'yes' }] },
      { checkFollowsBusiness: async () => true }
    ),
    true
  );
  assert.equal(
    await evaluateCondition(
      makeContact({ phone: 'ig:99999' }),
      { conditions: [{ type: 'follows_account', field: '', operator: '=', value: 'no' }] },
      { checkFollowsBusiness: async () => false }
    ),
    true
  );

  // "any" short-circuits before calling the (expensive) follow-check API.
  let calls = 0;
  await evaluateCondition(
    vip,
    {
      combinator: 'any',
      conditions: [
        { type: 'tag', field: '', operator: '=', value: 'vip' },
        { type: 'follows_account', field: '', operator: '=', value: 'yes' },
      ],
    },
    {
      checkFollowsBusiness: async () => {
        calls += 1;
        return true;
      },
    }
  );
  assert.equal(calls, 0, 'any() should short-circuit before the follow-check call');

  // system_field: contact-level presets (name split, email, phone, id) need no ctx.
  const person = makeContact({ name: 'Ada Lovelace', email: 'ada@x.com', phone: '+1555', id: 'c42' });
  assert.equal(
    await evaluateCondition(person, {
      conditions: [{ type: 'system_field', field: 'firstName', operator: '=', value: 'Ada' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(person, {
      conditions: [{ type: 'system_field', field: 'lastName', operator: '=', value: 'Lovelace' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(person, {
      conditions: [{ type: 'system_field', field: 'id', operator: '=', value: 'c42' }],
    }),
    true
  );
  // Single-word name → lastName resolves to '' (documented edge case), not a throw.
  assert.equal(
    await evaluateCondition(makeContact({ name: 'Madonna' }), {
      conditions: [{ type: 'system_field', field: 'lastName', operator: '=', value: '' }],
    }),
    true
  );

  // system_field: cached Instagram profile snapshot (populated by instagramProfile.ts).
  const igContact = makeContact({
    customFields: {
      instagramUsername: 'ada.codes',
      instagramFollowerCount: '2500',
      instagramVerified: 'yes',
      instagramBusinessFollowsUser: 'no',
    },
  });
  assert.equal(
    await evaluateCondition(igContact, {
      conditions: [{ type: 'system_field', field: 'ig.username', operator: '=', value: 'ada.codes' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(igContact, {
      conditions: [{ type: 'system_field', field: 'ig.followerCount', operator: '>', value: 1000 }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(igContact, {
      conditions: [{ type: 'system_field', field: 'ig.verified', operator: '=', value: 'yes' }],
    }),
    true
  );
  assert.equal(
    await evaluateCondition(igContact, {
      conditions: [{ type: 'system_field', field: 'ig.businessFollowsContact', operator: '=', value: 'yes' }],
    }),
    false
  );

  // system_field: activity-backed fields (last reply type / interaction / seen / window),
  // driven by an injected getContactActivity — and memoized across rows in one evaluation.
  const now = new Date('2026-08-03T00:00:00Z');
  let activityCalls = 0;
  const activityCtx = {
    now,
    getContactActivity: async () => {
      activityCalls += 1;
      return {
        lastInboundAt: new Date('2026-08-02T12:00:00Z'), // 12h ago → within_24h
        lastInboundType: 'image',
        lastActivityAt: new Date('2026-08-01T00:00:00Z'), // 2 days ago
      };
    },
  };
  assert.equal(
    await evaluateCondition(
      person,
      { conditions: [{ type: 'system_field', field: 'lastReplyType', operator: '=', value: 'image' }] },
      activityCtx
    ),
    true
  );
  assert.equal(
    await evaluateCondition(
      person,
      { conditions: [{ type: 'system_field', field: 'ig.messagingWindow', operator: '=', value: 'within_24h' }] },
      activityCtx
    ),
    true
  );
  assert.equal(
    await evaluateCondition(
      person,
      { conditions: [{ type: 'system_field', field: 'ig.lastSeenDays', operator: '>', value: 1 }] },
      activityCtx
    ),
    true
  );

  // Memoization: a single evaluateCondition call with 2 activity-backed rows should hit
  // getContactActivity exactly once, not twice.
  const callsBeforeMulti = activityCalls;
  assert.equal(
    await evaluateCondition(
      person,
      {
        combinator: 'all',
        conditions: [
          { type: 'system_field', field: 'lastReplyType', operator: '=', value: 'image' },
          { type: 'system_field', field: 'ig.lastInteractionDays', operator: '<', value: 1 },
        ],
      },
      activityCtx
    ),
    true
  );
  assert.equal(
    activityCalls - callsBeforeMulti,
    1,
    'getContactActivity should be memoized within one evaluateCondition call'
  );

  // No activity ctx → never messaged → "> N days" reads true, never throws.
  assert.equal(
    await evaluateCondition(person, {
      conditions: [{ type: 'system_field', field: 'ig.lastInteractionDays', operator: '>', value: 9999 }],
    }),
    true
  );

  // current_time: no ctx.getTimezone (e.g. caller didn't wire it) → fail-closed false.
  assert.equal(
    await evaluateCondition(person, {
      conditions: [{ type: 'current_time', field: '', operator: '=', value: '{}' }],
    }),
    false
  );
  // current_time: business-hours window, with an injected clock + timezone.
  const noon = new Date('2026-08-03T06:30:00Z'); // 12:00 IST
  const bhCtx = { now: noon, getTimezone: async () => 'Asia/Kolkata' };
  assert.equal(
    await evaluateCondition(
      person,
      {
        conditions: [
          {
            type: 'current_time',
            field: '',
            operator: '=',
            value: JSON.stringify({ startTime: '09:00', endTime: '18:00' }),
          },
        ],
      },
      bhCtx
    ),
    true
  );
  assert.equal(
    await evaluateCondition(
      person,
      {
        conditions: [
          {
            type: 'current_time',
            field: '',
            operator: '!=',
            value: JSON.stringify({ startTime: '09:00', endTime: '18:00' }),
          },
        ],
      },
      bhCtx
    ),
    false
  );

  // pickBranchEdge unchanged.
  const edges = [
    { targetNodeId: 'a', conditionValue: 'yes' },
    { targetNodeId: 'b', conditionValue: 'no' },
  ];
  assert.equal(pickBranchEdge(edges, true)?.targetNodeId, 'a');
  assert.equal(pickBranchEdge(edges, false)?.targetNodeId, 'b');

  console.log('condition-evaluator.service check ok');
}

run();
