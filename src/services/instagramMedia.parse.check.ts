import assert from 'node:assert/strict';
import {
  parseGraphInstagramMessage,
  parseInboundInstagramMessage,
} from './instagramMedia.js';

const withUrl = parseGraphInstagramMessage('', {
  data: [
    {
      mime_type: 'image/jpeg',
      name: 'x.jpg',
      image_data: { url: 'https://cdn.example.com/x.jpg' },
    },
  ],
});
assert.equal(withUrl.kind, 'image');
assert.ok(withUrl.media?.url);
assert.notEqual(withUrl.content, '[media]');

const noUrl = parseGraphInstagramMessage('', {
  data: [{ mime_type: 'image/jpeg', image_data: {} }],
});
assert.equal(noUrl.kind, 'image');
assert.notEqual(noUrl.content, '[media]');

const empty = parseGraphInstagramMessage('', undefined);
assert.notEqual(empty.content, '[media]');

const webhookNoUrl = parseInboundInstagramMessage(undefined, [
  { type: 'share', payload: {} },
]);
assert.notEqual(webhookNoUrl.content, '[media]');

console.log('instagramMedia.parse.check: ok');
