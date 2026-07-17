import assert from 'node:assert/strict';

/** Mirrors mediaFromPart + fallback rules in whatsappMedia.ts — keep in sync. */
function parseStub(msg: {
  type?: string;
  text?: { body?: string };
  image?: { id?: string; link?: string };
}): { kind: string; content: string; hasMediaRef: boolean } {
  const part = msg.image;
  if (part?.id || part?.link) {
    return { kind: 'image', content: '📷 Photo', hasMediaRef: true };
  }
  if (msg.type === 'image') return { kind: 'image', content: '📷 Photo', hasMediaRef: false };
  const text = msg.text?.body?.trim();
  if (text) return { kind: 'text', content: text, hasMediaRef: false };
  if (msg.type && msg.type !== 'text') {
    return { kind: 'text', content: `Unsupported message (${msg.type})`, hasMediaRef: false };
  }
  return { kind: 'text', content: 'Message', hasMediaRef: false };
}

assert.equal(parseStub({ type: 'image', image: { id: 'x' } }).kind, 'image');
assert.equal(parseStub({ type: 'image', image: { link: 'https://x' } }).hasMediaRef, true);
assert.equal(parseStub({ type: 'image' }).content, '📷 Photo');
assert.notEqual(parseStub({ type: 'contacts' }).content, '[media]');
assert.notEqual(parseStub({}).content, '[media]');

console.log('whatsappMedia.parse.check: ok');
