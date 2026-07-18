/**
 * Self-check: channel secret encrypt/decrypt round-trip + prefix.
 * Run: npx tsx backend/src/lib/field-encryption.secret.check.ts
 */
import assert from 'node:assert/strict';
import {
  SECRET_PREFIX,
  decryptSecret,
  encryptSecret,
  encryptSecretIfPlain,
} from './field-encryption.ts';

process.env.ENCRYPTION_KEY ??= 'test-channel-token-encryption-key';

const plain = 'EAAG-test-token-value';
const enc = encryptSecret(plain);
assert.ok(enc.startsWith(SECRET_PREFIX));
assert.notEqual(enc, plain);
assert.equal(decryptSecret(enc), plain);
assert.equal(decryptSecret(plain), plain, 'legacy plaintext passthrough');
assert.equal(encryptSecretIfPlain(enc), enc, 'idempotent if already encrypted');
assert.ok(encryptSecretIfPlain(plain)!.startsWith(SECRET_PREFIX));
assert.equal(decryptSecret(null), null);

console.log('field-encryption.secret.check.ts: ok');
