import assert from 'node:assert/strict';
import {
  socialListeningActionBodySchema,
  socialListeningRangeQuerySchema,
  socialListeningSettingsBodySchema,
} from './socialListening.schemas.js';

assert.equal(socialListeningSettingsBodySchema.safeParse(undefined).success, true);
assert.equal(socialListeningSettingsBodySchema.safeParse({ autoReply: true }).success, true);
assert.equal(socialListeningRangeQuerySchema.safeParse({ range: '7d' }).success, true);
assert.equal(socialListeningActionBodySchema.safeParse({ action: 'ignore' }).success, true);
assert.equal(socialListeningActionBodySchema.safeParse({ hidden: 'yes' }).success, false);

console.log('socialListening.schemas.check.ts: ok');
