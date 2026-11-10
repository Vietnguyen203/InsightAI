import { type ArgumentsHost, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { OpsMetricsService } from '../ops/ops-metrics.service';
import { ConflictError, ValidationError } from './app-error';
import { ProblemDetailsFilter } from './problem-details.filter';

describe('ProblemDetailsFilter.toProblem', () => {
  const filter = new ProblemDetailsFilter();

  it('maps AppError with field errors', () => {
    const problem = filter.toProblem(
      new ValidationError('Invalid input', [{ path: 'name', message: 'Required' }]),
    );
    expect(problem).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Invalid input',
      errors: [{ path: 'name', message: 'Required' }],
    });
  });

  it('maps AppError subclasses to their status', () => {
    expect(filter.toProblem(new ConflictError('exists'))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('maps Nest HttpException', () => {
    expect(filter.toProblem(new NotFoundException())).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('hides internals of unknown errors', () => {
    const problem = filter.toProblem(new Error('connection string postgres://user:pw@host'));
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(problem)).not.toContain('postgres://');
  });
});

describe('ProblemDetailsFilter.catch', () => {
  const host = () => {
    const res = { status: vi.fn(), type: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    res.type.mockReturnValue(res);
    const req = { originalUrl: '/api/v1/x', id: 'r1' };
    return {
      res,
      host: {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ArgumentsHost,
    };
  };

  it('counts server errors for the operations monitor, not client errors', () => {
    const ops = { recordServerError: vi.fn() };
    const filter = new ProblemDetailsFilter(ops as unknown as OpsMetricsService);
    (filter as unknown as { logger: { error: () => void } }).logger = { error: () => undefined };
    const a = host();
    filter.catch(new Error('boom'), a.host);
    expect(a.res.status).toHaveBeenCalledWith(500);
    filter.catch(new NotFoundException(), host().host);
    expect(ops.recordServerError).toHaveBeenCalledTimes(1);
  });
});
