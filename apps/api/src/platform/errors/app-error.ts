import { ErrorCode } from '@insightai/contracts';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Base class for expected, domain-level failures. Anything that is not an AppError
 * (or a Nest HttpException) is treated as an unexpected 500 and its message is hidden.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: ErrorCode;

  constructor(
    message: string,
    readonly errors?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = ErrorCode.VALIDATION_FAILED;
}

export class UnauthenticatedError extends AppError {
  readonly status = 401;
  readonly code = ErrorCode.UNAUTHENTICATED;
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = ErrorCode.FORBIDDEN;
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = ErrorCode.NOT_FOUND;
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = ErrorCode.CONFLICT;
}

export class QueryRejectedError extends AppError {
  readonly status = 422;
  readonly code = ErrorCode.QUERY_REJECTED;
}

export class ExternalServiceError extends AppError {
  readonly status = 502;
  readonly code = ErrorCode.EXTERNAL_SERVICE_ERROR;
}
