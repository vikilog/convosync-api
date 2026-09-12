export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class ExternalServiceError extends AppError {
  readonly statusCode = 502;
  readonly code = 'EXTERNAL_SERVICE_ERROR';
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}
