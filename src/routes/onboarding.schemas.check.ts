import assert from 'node:assert/strict';
import { onboardingStepBodySchema } from './onboarding.schemas.js';

assert.equal(onboardingStepBodySchema.safeParse({ step: 1 }).success, true);
assert.equal(onboardingStepBodySchema.safeParse({ step: 7, skip: true }).success, true);
assert.equal(onboardingStepBodySchema.safeParse({ step: 0 }).success, false);
assert.equal(onboardingStepBodySchema.safeParse({}).success, false);

console.log('onboarding.schemas.check.ts: ok');
