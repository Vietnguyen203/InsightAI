import { describe, expect, it } from 'vitest';
import { problemDetailsSchema } from './problem.js';

describe('problemDetailsSchema', () => {
  it('accepts a minimal problem document', () => {
    const parsed = problemDetailsSchema.parse({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('rejects unknown error codes', () => {
    expect(() =>
      problemDetailsSchema.parse({ type: 'x', title: 'x', status: 500, code: 'NOPE' }),
    ).toThrow();
  });
});
