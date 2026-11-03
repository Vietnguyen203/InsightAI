import { loginRequestSchema } from '@insightai/contracts';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors/app-error';
import { ZodValidationPipe } from './zod';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(loginRequestSchema);

  it('returns the parsed (transformed) value', () => {
    expect(pipe.transform({ email: '  Alice@Example.COM ', password: 'x' })).toEqual({
      email: 'alice@example.com',
      password: 'x',
    });
  });

  it('throws a ValidationError with field paths', () => {
    try {
      pipe.transform({ email: 'nope' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).errors?.map((e) => e.path).sort()).toEqual([
        'email',
        'password',
      ]);
    }
  });
});
