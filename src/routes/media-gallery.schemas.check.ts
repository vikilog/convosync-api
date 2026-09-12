import assert from 'node:assert/strict';
import {
  mediaGalleryScopeSchema,
  mediaGalleryTypeSchema,
  mediaGalleryUpdateSchema,
} from './media-gallery.schemas.js';

assert.equal(mediaGalleryUpdateSchema.safeParse({}).success, true);
assert.equal(mediaGalleryUpdateSchema.safeParse({ title: '' }).success, false);
assert.equal(mediaGalleryUpdateSchema.safeParse({ isActive: true }).success, true);
assert.equal(mediaGalleryScopeSchema.safeParse('customer').success, true);
assert.equal(mediaGalleryScopeSchema.safeParse('nope').success, false);
assert.equal(mediaGalleryTypeSchema.safeParse('image').success, true);
assert.equal(mediaGalleryTypeSchema.safeParse('zip').success, false);

console.log('media-gallery.schemas.check.ts: ok');
