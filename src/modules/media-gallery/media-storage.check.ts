/**
 * ponytail: self-check for replace-key cleanup (no S3).
 * Run: npx tsx src/modules/media-gallery/media-storage.check.ts
 */
import { shouldDeleteReplacedMediaKey } from './media-storage.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(
  shouldDeleteReplacedMediaKey('ws/media-gallery/id.jpg', 'ws/media-gallery/id.png'),
  'ext change deletes old'
);
assert(
  !shouldDeleteReplacedMediaKey('ws/media-gallery/id.jpg', 'ws/media-gallery/id.jpg'),
  'same key keeps (overwrite)'
);
assert(!shouldDeleteReplacedMediaKey(null, 'ws/media-gallery/id.jpg'), 'no old key');
assert(!shouldDeleteReplacedMediaKey(undefined, 'ws/media-gallery/id.jpg'), 'undefined old');

console.log('media-storage.check: ok');
