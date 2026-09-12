import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PINO_REDACT_CENSOR, pinoRedactOptions } from './pinoRedact.js';

let buf = '';
const logger = pino(
  { redact: pinoRedactOptions },
  new Writable({
    write(chunk, _enc, cb) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      cb();
    },
  })
);

logger.info({
  req: {
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      authorization: 'Bearer super-secret',
      cookie: 'sid=abc',
      'x-convosync-internal': 'internal-secret',
    },
  },
  password: 'hunter2',
  user: { email: 'a@b.co', phone: '+919999999999', token: 'tok_live', password: 'nested-pw' },
  message: { text: 'hi there', from: '9198', body: 'plain body' },
  code: 'VALIDATION_ERROR',
});

const rec = JSON.parse(buf) as {
  req: { method: string; url: string; headers: Record<string, string> };
  password: string;
  user: { email: string; phone: string; token: string; password: string };
  message: { text: string; from: string; body: string };
  code: string;
};

assert.equal(rec.req.method, 'POST');
assert.equal(rec.req.url, '/api/auth/login');
assert.equal(rec.req.headers.authorization, PINO_REDACT_CENSOR);
assert.equal(rec.req.headers.cookie, PINO_REDACT_CENSOR);
assert.equal(rec.req.headers['x-convosync-internal'], PINO_REDACT_CENSOR);
assert.equal(rec.password, PINO_REDACT_CENSOR);
assert.equal(rec.user.password, PINO_REDACT_CENSOR);
assert.equal(rec.user.email, PINO_REDACT_CENSOR);
assert.equal(rec.user.phone, PINO_REDACT_CENSOR);
assert.equal(rec.user.token, PINO_REDACT_CENSOR);
assert.equal(rec.message.text, PINO_REDACT_CENSOR);
assert.equal(rec.message.from, PINO_REDACT_CENSOR);
assert.equal(rec.message.body, PINO_REDACT_CENSOR);
assert.equal(rec.code, 'VALIDATION_ERROR');
assert.equal(buf.includes('super-secret'), false);
assert.equal(buf.includes('hunter2'), false);
assert.equal(buf.includes('tok_live'), false);

console.log('pinoRedact.check.ts: ok');
