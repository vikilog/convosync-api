import assert from 'node:assert/strict';
import { parsePersistentMenu } from './workspaceAutomationSettings.service.js';

const parsed = parsePersistentMenu({
  enabled: true,
  items: [
    { id: '1', title: 'Talk to us', type: 'postback', payload: 'CARE' },
    { id: '2', title: 'Shop', type: 'web_url', url: 'https://example.com' },
    { id: 'x', title: '', type: 'postback' },
  ],
});
assert.equal(parsed.enabled, true);
assert.equal(parsed.items.length, 2);
assert.equal(parsed.items[0].payload, 'CARE');
assert.equal(parsed.items[1].type, 'web_url');

assert.equal(parsePersistentMenu(null).enabled, false);
console.log('workspaceAutomationSettings.check: ok');
