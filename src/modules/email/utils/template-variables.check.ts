/**
 * Self-check: stripHtmlToText must keep structure and decode entities.
 * Run: npx tsx backend/src/modules/email/utils/template-variables.check.ts
 */
import assert from 'node:assert/strict';
import { stripHtmlToText } from './template-variables.js';

const html = `<p>Hi Alex,</p><p>Next steps:</p><ul><li>Connect WhatsApp</li><li>Create a reply</li></ul><a href="#">Complete Setup</a>&nbsp;<p>WhatsApp&nbsp;-&nbsp;Instagram</p>`;

const text = stripHtmlToText(html);

assert.doesNotMatch(text, /&nbsp;/i, 'must not leave literal &nbsp;');
assert.match(text, /Hi Alex,/);
assert.match(text, /Connect WhatsApp/);
assert.match(text, /Complete Setup/);
assert.ok(text.includes('\n'), 'must preserve paragraph breaks');
assert.equal(stripHtmlToText('A&amp;nbsp;B'), 'A B');

console.log('template-variables.check.ts: ok');
