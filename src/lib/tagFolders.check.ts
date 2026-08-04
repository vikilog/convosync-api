/**
 * Run: npx tsx src/lib/tagFolders.check.ts
 */
import assert from 'node:assert/strict';
import { groupTagsByFolder, normalizeTagFolder, UNCATEGORIZED_TAG_FOLDER } from './tagFolders.js';

assert.equal(normalizeTagFolder('  Instagram  '), 'Instagram');
assert.equal(normalizeTagFolder(''), null);
assert.equal(normalizeTagFolder('   '), null);
assert.equal(normalizeTagFolder(null), null);
assert.equal(normalizeTagFolder(undefined), null);

const tags = [
  { name: 'vip', folder: 'Sales' },
  { name: 'hot', folder: null },
  { name: 'lead', folder: 'Sales' },
  { name: 'ig_dm', folder: 'Instagram' },
  { name: 'cold', folder: null },
];

const grouped = groupTagsByFolder(tags);
assert.deepEqual(
  grouped.map((g) => g.folder),
  ['Instagram', 'Sales', UNCATEGORIZED_TAG_FOLDER]
);
assert.deepEqual(grouped.find((g) => g.folder === 'Sales')?.items.map((i) => i.name), ['lead', 'vip']);
assert.deepEqual(
  grouped.find((g) => g.folder === UNCATEGORIZED_TAG_FOLDER)?.items.map((i) => i.name),
  ['cold', 'hot']
);

console.log('tagFolders.check: ok');
