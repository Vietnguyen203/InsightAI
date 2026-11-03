import { describe, expect, it } from 'vitest';
import { assertTenantSchema, tenantReaderRole, tenantWriterRole } from './tenant-schema';

describe('tenant schema names', () => {
  it('accepts generated names', () => {
    expect(assertTenantSchema('t_8f3k2abc')).toBe('t_8f3k2abc');
    expect(tenantReaderRole('t_8f3k2abc')).toBe('t_8f3k2abc_reader');
    expect(tenantWriterRole('t_8f3k2abc')).toBe('t_8f3k2abc_writer');
  });

  it.each([
    'app',
    'public',
    't_short',
    't_UPPERCASE1',
    't_abc12345"; DROP SCHEMA app; --',
    'pg_catalog',
  ])('rejects %s', (name) => {
    expect(() => assertTenantSchema(name)).toThrow();
  });
});
