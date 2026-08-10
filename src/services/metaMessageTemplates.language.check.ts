/**
 * ponytail: language normalize must not coerce en ↔ en_US (Meta treats them as different templates).
 * Run: npx tsx src/services/metaMessageTemplates.language.check.ts
 */
import assert from 'node:assert/strict';
import { normalizeMetaLanguageCode } from './metaMessageTemplates.js';

assert.equal(normalizeMetaLanguageCode('en'), 'en');
assert.equal(normalizeMetaLanguageCode('en_US'), 'en_US');
assert.equal(normalizeMetaLanguageCode('en_GB'), 'en_GB');
assert.equal(normalizeMetaLanguageCode('hi'), 'hi');
assert.equal(normalizeMetaLanguageCode('English'), 'en');
assert.equal(normalizeMetaLanguageCode('English (US)'), 'en_US');
assert.equal(normalizeMetaLanguageCode('English US'), 'en_US');
assert.equal(normalizeMetaLanguageCode('English (UK)'), 'en_GB');
assert.equal(normalizeMetaLanguageCode('  en_US  '), 'en_US');

console.log('metaMessageTemplates.language.check.ts: ok');
