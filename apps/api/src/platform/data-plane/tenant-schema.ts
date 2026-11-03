import { ValidationError } from '../errors/app-error';

/** Tenant schema names are generated server-side; anything else is rejected before reaching SQL. */
const TENANT_SCHEMA_PATTERN = /^t_[a-z0-9]{8,12}$/;

export function assertTenantSchema(schema: string): string {
  if (!TENANT_SCHEMA_PATTERN.test(schema)) {
    throw new ValidationError('Invalid tenant schema name');
  }
  return schema;
}

export const tenantReaderRole = (schema: string): string => `${assertTenantSchema(schema)}_reader`;
export const tenantWriterRole = (schema: string): string => `${assertTenantSchema(schema)}_writer`;
