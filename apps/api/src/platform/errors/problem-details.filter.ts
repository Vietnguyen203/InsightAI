import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ErrorCode, type ProblemDetails } from '@insightai/contracts';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

const HTTP_STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/** Converts every thrown error into an RFC 7807 `application/problem+json` response. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();

    const problem = this.toProblem(exception);
    problem.instance = req.originalUrl;
    if (req.id !== undefined) problem.requestId = String(req.id);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: problem.requestId }, 'Unhandled error');
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof AppError) {
      return {
        type: 'about:blank',
        title: STATUS_CODES[exception.status] ?? 'Error',
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Error',
        status,
        code:
          HTTP_STATUS_TO_CODE[status] ??
          (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_FAILED),
        detail: status >= 500 ? undefined : exception.message,
      };
    }

    // Unknown error: never leak internals to the client.
    return {
      type: 'about:blank',
      title: STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR] ?? 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
    };
  }
}
