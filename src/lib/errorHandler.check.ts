import assert from 'node:assert/strict';
import { ZodError, z } from 'zod';
import { mapErrorToResponse } from './errorHandler.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

const zodErr = (() => {
  try {
    z.object({ email: z.string().email() }).parse({});
  } catch (e) {
    return e as ZodError;
  }
  throw new Error('expected ZodError');
})();

let mapped = mapErrorToResponse(zodErr);
assert.equal(mapped.statusCode, 400);
assert.equal(mapped.payload.code, 'VALIDATION_ERROR');
assert.equal(mapped.log, false);

mapped = mapErrorToResponse(new NotFoundError('nope'));
assert.equal(mapped.statusCode, 404);
assert.equal(mapped.payload.error, 'nope');
assert.equal(mapped.payload.code, 'NOT_FOUND');

mapped = mapErrorToResponse(new ValidationError('bad field', { field: 'email' }));
assert.equal(mapped.statusCode, 400);
assert.deepEqual(mapped.payload.details, { field: 'email' });

mapped = mapErrorToResponse(new ConflictError('taken'));
assert.equal(mapped.statusCode, 409);

class CallingLike extends Error {
  statusCode = 409;
  code = 'CALL_CONFLICT';
  constructor() {
    super('busy');
    this.name = 'CallingError';
  }
}
mapped = mapErrorToResponse(new CallingLike());
assert.equal(mapped.statusCode, 409);
assert.equal(mapped.payload.code, 'CALL_CONFLICT');

class PlanGateError extends Error {
  upgradePath = '/settings/subscription';
  constructor() {
    super('upgrade required');
    this.name = 'PlanGateError';
  }
}
mapped = mapErrorToResponse(new PlanGateError());
assert.equal(mapped.statusCode, 403);
assert.equal(mapped.payload.upgradePath, '/settings/subscription');

const fstZod = Object.assign(new Error('body/email Required'), {
  statusCode: 400,
  code: 'FST_ERR_VALIDATION',
  validation: [
    {
      [Symbol.for('ZodFastifySchemaValidationError')]: true,
      keyword: 'invalid_type',
      instancePath: '/email',
      schemaPath: '#/email/invalid_type',
      params: { issue: {} },
      message: 'Required',
    },
  ],
});
mapped = mapErrorToResponse(fstZod);
assert.equal(mapped.statusCode, 400);
assert.equal(mapped.payload.code, 'VALIDATION_ERROR');
assert.deepEqual(mapped.payload.details, { formErrors: [], fieldErrors: { email: ['Required'] } });

mapped = mapErrorToResponse(new Error('secret stack should not leak'));
assert.equal(mapped.statusCode, 500);
assert.equal(mapped.payload.error, 'Internal server error');
assert.equal(mapped.payload.code, 'INTERNAL_ERROR');
assert.equal(String(mapped.payload.error).includes('secret'), false);
assert.equal(mapped.log, true);

console.log('errorHandler.check.ts: ok');
