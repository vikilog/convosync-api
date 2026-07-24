/**
 * Runnable check for media keyword fallback.
 * Run: npx tsx src/modules/media-gallery/media-match.check.ts
 */
import assert from 'node:assert/strict';
import { keywordMediaFallback, type MediaCatalogItem } from './media-match.js';

const catalog: MediaCatalogItem[] = [
  {
    id: 'intro1',
    type: 'image',
    title: 'ConvoSync Intro',
    description: 'Product intro image',
    tags: ['intro', 'brand'],
  },
  {
    id: 'price1',
    type: 'pdf',
    title: 'Price list',
    description: 'Plans and pricing',
    tags: ['pricing'],
  },
];

assert.equal(keywordMediaFallback('Intro image do', catalog), 'intro1');
assert.equal(keywordMediaFallback('intro image dedo', catalog), 'intro1');
assert.equal(keywordMediaFallback('plan price list PDF', catalog), 'price1');
assert.equal(keywordMediaFallback('hello', catalog), null);

console.log('media-match.check: ok');
