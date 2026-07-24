import assert from 'node:assert/strict';
import { extractTextFromHtml } from './html-text-extract.js';

const spaShell = `<!doctype html>
<html lang="en">
  <head>
    <title>ConvoSync — Complete Customer Ops Platform</title>
    <meta
      name="description"
      content="ConvoSync unifies WhatsApp, Instagram, email, and AI agents into one workspace — inbox, campaigns, journeys, WhatsApp Pay, and Meta Ads for growing teams."
    />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const spa = extractTextFromHtml(spaShell);
assert.ok(spa.bodyText.includes('WhatsApp'));
assert.ok(spa.bodyText.split(/\s+/).filter(Boolean).length > 10);
assert.equal(spa.source, 'meta_fallback');
assert.ok(spa.title.includes('ConvoSync'));

const staticHtml = `<!doctype html><html><head><title>Pricing</title></head>
<body><main><h1>Plans</h1><p>Starter plan costs ninety nine dollars per month for small teams.</p></main></body></html>`;
const page = extractTextFromHtml(staticHtml);
assert.equal(page.source, 'body');
assert.ok(page.bodyText.includes('ninety nine'));

console.log('html-text-extract.check: ok');
