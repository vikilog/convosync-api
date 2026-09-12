import assert from 'node:assert/strict';
import {
  aiContextQuerySchema,
  listCollectionsSchema,
  saveAiKnowledgeConfigSchema,
  syncAiKnowledgeSchema,
  syncCollectionSchema,
} from './ai-knowledge.schemas.js';

assert.equal(saveAiKnowledgeConfigSchema.safeParse({ venueId: 'v1' }).success, true);
assert.equal(saveAiKnowledgeConfigSchema.safeParse({}).success, false);
assert.equal(
  syncAiKnowledgeSchema.safeParse({
    connectionString: 'mongodb://localhost:27017',
    venueId: 'v1',
  }).success,
  true
);
assert.equal(
  syncAiKnowledgeSchema.safeParse({ connectionString: 'postgres://x', venueId: 'v1' }).success,
  false
);
assert.equal(
  listCollectionsSchema.safeParse({
    connectionString: 'mongodb+srv://h/db',
    venueId: 'v1',
  }).success,
  true
);
assert.equal(
  syncCollectionSchema.safeParse({
    connectionString: 'mongodb://localhost:27017',
    venueId: 'v1',
    collectionName: 'menus',
  }).success,
  true
);
assert.equal(
  syncCollectionSchema.safeParse({
    connectionString: 'mongodb://localhost:27017',
    venueId: 'v1',
  }).success,
  false
);
assert.equal(aiContextQuerySchema.safeParse({ query: 'hours', venueId: 'v1' }).success, true);
assert.equal(aiContextQuerySchema.safeParse({ query: '', venueId: 'v1' }).success, false);

console.log('ai-knowledge.schemas.check.ts: ok');
