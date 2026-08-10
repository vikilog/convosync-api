/**
 * ponytail: self-check for Content-Disposition encoding.
 * Run: npx tsx src/utils/contentDisposition.check.ts
 */
import { contentDisposition } from './contentDisposition.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const hindi = contentDisposition('inline', 'Franchise क्या होती है.png');
assert(hindi.startsWith('inline; filename="'), 'has ascii filename');
assert(!/[^\x20-\x7E]/.test(hindi.split("filename*=UTF-8''")[0]!), 'ascii part is ASCII-only');
assert(hindi.includes("filename*=UTF-8''"), 'has RFC 5987 filename*');
assert(hindi.includes('%'), 'unicode is percent-encoded');
assert(!hindi.includes('क्या'), 'raw Devanagari not in header value');

const quote = contentDisposition('attachment', 'say "hi".pdf');
assert(quote.includes('filename="say _hi_.pdf"'), `quotes stripped: ${quote}`);

const empty = contentDisposition('inline', '   ');
assert(empty.includes('filename="file"'), 'empty falls back');

console.log('contentDisposition.check: ok');
