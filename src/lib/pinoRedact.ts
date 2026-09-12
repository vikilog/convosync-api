/** Shared Fastify/pino redact. Secrets + contact/message PII. Do not add `*.code` (API error codes). */
export const PINO_REDACT_CENSOR = '[redacted]';

export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-convosync-internal',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.*.password',
  'token',
  '*.token',
  '*.*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.waToken',
  '*.secret',
  '*.apiKey',
  '*.apiSecret',
  '*.jwt',
  'email',
  '*.email',
  '*.*.email',
  'phone',
  '*.phone',
  '*.*.phone',
  '*.wa_id',
  '*.display_phone_number',
  '*.from',
  '*.to',
  '*.text',
  '*.body',
  '*.caption',
] as const;

export const pinoRedactOptions = {
  paths: [...PINO_REDACT_PATHS],
  censor: PINO_REDACT_CENSOR,
};
