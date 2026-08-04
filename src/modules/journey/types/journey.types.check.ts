/**
 * Run: npx tsx src/modules/journey/types/journey.types.check.ts
 */
import assert from 'node:assert/strict';
import { normalizeConditionGroup } from './journey.types.ts';

// Legacy single-condition object (no `conditions` array) → 1-item list, combinator "all".
const legacy = normalizeConditionGroup({ field: 'contact.name', operator: 'contains', value: 'Sam' });
assert.equal(legacy.combinator, 'all');
assert.deepEqual(legacy.conditions, [
  { type: 'field', field: 'contact.name', operator: 'contains', value: 'Sam' },
]);

// New multi-condition shape passes through untouched.
const multi = normalizeConditionGroup({
  combinator: 'any',
  conditions: [
    { type: 'tag', field: '', operator: '=', value: 'vip' },
    { type: 'channel', field: '', operator: '=', value: 'instagram' },
  ],
});
assert.equal(multi.combinator, 'any');
assert.equal(multi.conditions.length, 2);

// Unknown/invalid combinator defaults to "all".
assert.equal(
  normalizeConditionGroup({ conditions: [{ field: 'a', operator: '=', value: '1' }], combinator: 'bogus' })
    .combinator,
  'all'
);

// Empty/garbage data → empty condition list (caller should fail-closed, never crash).
assert.deepEqual(normalizeConditionGroup(null), { conditions: [], combinator: 'all' });
assert.deepEqual(normalizeConditionGroup({}), { conditions: [], combinator: 'all' });

console.log('journey.types check ok');
