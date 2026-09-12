import assert from 'node:assert/strict';
import { updateAiProviderSchema } from './ai-provider.schemas.js';

assert.equal(updateAiProviderSchema.safeParse({}).success, true);
assert.equal(updateAiProviderSchema.safeParse({ mode: 'byok' }).success, true);
assert.equal(updateAiProviderSchema.safeParse({ mode: 'nope' }).success, false);
assert.equal(updateAiProviderSchema.safeParse({ apiKey: 'short' }).success, false);
assert.equal(updateAiProviderSchema.safeParse({ baseUrl: 'not-a-url' }).success, false);
assert.equal(updateAiProviderSchema.safeParse({ baseUrl: '' }).success, true);
assert.equal(updateAiProviderSchema.safeParse({ baseUrl: null }).success, true);

console.log('ai-provider.schemas.check.ts: ok');
