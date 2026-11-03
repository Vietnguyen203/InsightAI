import { applyDecorators, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse, type SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import { ValidationError } from '../errors/app-error';

/** Validates and transforms a request part with a Zod schema from `@insightai/contracts`. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        'Request validation failed',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}

export const zod = <T extends z.ZodType>(schema: T) => new ZodValidationPipe(schema);

function toOpenApi(schema: z.ZodType, io: 'input' | 'output'): SchemaObject {
  return z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as SchemaObject;
}

/** Documents a Zod request body in Swagger (one schema definition for validation and docs). */
export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: toOpenApi(schema, 'input') });

export const ApiZodResponse = (status: number, schema: z.ZodType, description?: string) =>
  ApiResponse({ status, description, schema: toOpenApi(schema, 'output') });

/** Documents each property of a Zod object schema as a query parameter. */
export const ApiZodQuery = (schema: z.ZodObject) =>
  applyDecorators(
    ...Object.entries(schema.shape).map(([name, field]) =>
      ApiQuery({
        name,
        required: !(field as z.ZodType).safeParse(undefined).success,
        schema: toOpenApi(field as z.ZodType, 'input'),
      }),
    ),
  );
