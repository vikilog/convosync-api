import assert from 'node:assert/strict';
import {
  telegramConnectBodySchema,
  telegramDisconnectBodySchema,
  telegramDisconnectQuerySchema,
} from './telegram.schemas.js';

assert.equal(telegramConnectBodySchema.safeParse(undefined).success, true);
assert.equal(telegramConnectBodySchema.safeParse({ botToken: 'x' }).success, true);
assert.equal(telegramDisconnectQuerySchema.safeParse({}).success, true);
assert.equal(telegramDisconnectBodySchema.safeParse({}).success, true);

console.log('telegram.schemas.check.ts: ok');
