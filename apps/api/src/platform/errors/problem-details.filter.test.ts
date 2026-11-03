import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
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
