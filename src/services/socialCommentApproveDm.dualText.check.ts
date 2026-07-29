// Contract check for dual-reply JSON shape used by approve_dm AI prompt.
function parseDual(content: string): { publicReply: string; dmReply: string } {
  const parsed = JSON.parse(content) as { publicReply?: string; dmReply?: string };
  const publicReply = (parsed.publicReply || '').trim();
  const dmReply = (parsed.dmReply || '').trim();
  if (!publicReply || !dmReply) throw new Error('empty');
  return { publicReply, dmReply };
}

const ok = parseDual(
  JSON.stringify({
    publicReply: 'Thanks — just DMd you!',
    dmReply: 'Hey! Happy to help with pricing. What are you looking for?',
  })
);
console.assert(ok.publicReply.includes('DMd'));
console.assert(ok.dmReply.length > 10);

let failed = false;
try {
  parseDual('{"publicReply":""}');
} catch {
  failed = true;
}
console.assert(failed);

console.log('socialCommentApproveDm.dualText.check: ok');
