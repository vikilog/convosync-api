import assert from 'node:assert/strict';
import { andWhere, listTagWhere, normalizeListFilter } from './contactListQuery.js';

assert.equal(normalizeListFilter('blocklist'), 'blocklist');
assert.equal(normalizeListFilter('Blocked'), 'blocklist');
assert.equal(normalizeListFilter(['unsubscribe']), 'unsubscribe');
assert.equal(normalizeListFilter('all'), 'all');
assert.equal(normalizeListFilter(undefined), 'all');

assert.deepEqual(listTagWhere('all'), undefined);
assert.deepEqual(listTagWhere('blocklist'), {
  tags: { hasSome: ['Blocked', 'Blocklist', 'Blocklisted'] },
});
assert.deepEqual(listTagWhere('unsubscribe'), {
  tags: { hasSome: ['Unsubscribed', 'Unsubscribe'] },
});

const combined = andWhere([
  { workspaceId: 'w1' },
  listTagWhere('blocklist'),
  { OR: [{ phone: { startsWith: 'tg:' } }] },
  { AND: [{ NOT: { phone: { startsWith: 'ig:' } } }] },
]);
assert.deepEqual(combined, {
  AND: [
    { workspaceId: 'w1' },
    { tags: { hasSome: ['Blocked', 'Blocklist', 'Blocklisted'] } },
    { OR: [{ phone: { startsWith: 'tg:' } }] },
    { AND: [{ NOT: { phone: { startsWith: 'ig:' } } }] },
  ],
});

console.log('contactListQuery.ts: ok');
