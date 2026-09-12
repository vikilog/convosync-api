import assert from 'node:assert/strict';
import { installedAppParamsSchema } from './installedApps.schemas.js';

assert.equal(installedAppParamsSchema.safeParse({ appId: 'crm' }).success, true);
assert.equal(installedAppParamsSchema.safeParse({}).success, false);

console.log('installedApps.schemas.check.ts: ok');
