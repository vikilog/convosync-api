import assert from 'node:assert/strict';
import { triggerAllowsChannel } from '../types/journey.types.ts';

assert.equal(triggerAllowsChannel({}, 'whatsapp'), true);
assert.equal(triggerAllowsChannel({ channels: [] }, 'instagram'), true);
assert.equal(triggerAllowsChannel({ channels: ['whatsapp'] }, 'whatsapp'), true);
assert.equal(triggerAllowsChannel({ channels: ['whatsapp'] }, 'instagram'), false);
assert.equal(triggerAllowsChannel({ channels: ['whatsapp', 'messenger'] }, null), true);

console.log('triggerAllowsChannel check ok');
