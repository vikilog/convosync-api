/** Assert cursor encode/decode + day bound helpers stay in sync with contacts route. */
function encodeContactCursor(updatedAt: Date, id: string): string {
  return `${updatedAt.toISOString()}|${id}`;
}

function decodeContactCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const i = cursor.indexOf('|');
  if (i < 0) return null;
  const updatedAt = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (Number.isNaN(updatedAt.getTime()) || !id) return null;
  return { updatedAt, id };
}

function parseDayBound(ymd: string | undefined, end: boolean): Date | undefined {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
  return new Date(`${ymd}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

const t = new Date('2024-06-01T12:34:56.789Z');
const enc = encodeContactCursor(t, 'abc');
const dec = decodeContactCursor(enc);
if (!dec || dec.id !== 'abc' || dec.updatedAt.toISOString() !== t.toISOString()) {
  throw new Error(`cursor roundtrip failed: ${enc}`);
}
if (decodeContactCursor('bad') !== null) throw new Error('bad cursor should be null');
if (parseDayBound('2024-01-02', false)?.toISOString() !== '2024-01-02T00:00:00.000Z') {
  throw new Error('day start');
}
if (parseDayBound('2024-01-02', true)?.toISOString() !== '2024-01-02T23:59:59.999Z') {
  throw new Error('day end');
}
if (parseDayBound('nope', false) !== undefined) throw new Error('invalid day');

console.log('contacts-cursor.check.ts: ok');
