import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

export type MappedHttpError = {
  statusCode: number;
  payload: Record<string, unknown>;
  log: boolean;
};

function isPlanGate(err: unknown): err is Error & { upgradePath: string } {
  return (
    err instanceof Error &&
    err.name === 'PlanGateError' &&
    typeof (err as { upgradePath?: unknown }).upgradePath === 'string'
  );
}

function isShapedHttpError(err: unknown): err is Error & { statusCode: number; code: string } {
  if (!(err instanceof Error)) return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  const code = (err as { code?: unknown }).code;
  return typeof status === 'number' && status >= 400 && status < 600 && typeof code === 'string';
}

export function flattenZodFastifyValidation(issues: { instancePath: string; message: string }[]) {
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of issues) {
    const key = issue.instancePath.replace(/^\//, '').replace(/\//g, '.');
    if (!key) formErrors.push(issue.message);
    else (fieldErrors[key] ??= []).push(issue.message);
  }
  return { formErrors, fieldErrors };
}

function sendMappedError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const mapped = mapErrorToResponse(err);
  if (mapped.log) request.log.error({ err }, 'unhandled error');
  return reply.code(mapped.statusCode).send(mapped.payload);
}

/** Former `safeParse` `{ error: issues[0].message }` — do not use the global VALIDATION_ERROR body. */
export function zodFirstIssueErrorHandler(fallback: string) {
  return (err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: err.validation[0]?.message ?? fallback,
      });
    }
    return sendMappedError(err, request, reply);
  };
}

/** Former `safeParse` `{ error: flatten() }`. */
export function zodFlattenErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({
      error: flattenZodFastifyValidation(err.validation),
    });
  }
  return sendMappedError(err, request, reply);
}

/** Pure mapper — routes keep throwing; one handler sends the body. */
export function mapErrorToResponse(err: unknown): MappedHttpError {
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      payload: { error: 'Invalid request', code: 'VALIDATION_ERROR', details: err.flatten() },
      log: false,
    };
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      statusCode: 400,
      payload: {
        error: 'Invalid request',
        code: 'VALIDATION_ERROR',
        details: flattenZodFastifyValidation(err.validation),
      },
      log: false,
    };
  }
  const fastifyCode = (err as FastifyError).code;
  if (fastifyCode === 'FST_ERR_VALIDATION') {
    return {
      statusCode: 400,
      payload: { error: 'Invalid request', code: 'VALIDATION_ERROR' },
      log: false,
    };
  }
  if (err instanceof AppError) {
    const payload: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.details !== undefined) payload.details = err.details;
    return { statusCode: err.statusCode, payload, log: err.statusCode >= 500 };
  }
  if (isPlanGate(err)) {
    return {
      statusCode: 403,
      payload: { error: err.message, upgradePath: err.upgradePath },
      log: false,
    };
  }
  if (isShapedHttpError(err)) {
    return {
      statusCode: err.statusCode,
      payload: { error: err.message, code: err.code },
      log: err.statusCode >= 500,
    };
  }
  const fastifyErr = err as FastifyError;
  if (typeof fastifyErr?.statusCode === 'number' && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    return {
      statusCode: fastifyErr.statusCode,
      payload: { error: fastifyErr.message, code: fastifyErr.code },
      log: false,
    };
  }
  return {
    statusCode: 500,
    payload: { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    log: true,
  };
}

export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler(sendMappedError);
}
