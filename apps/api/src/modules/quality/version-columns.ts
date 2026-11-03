import type { ColumnDataType } from '@insightai/contracts';
import type { VersionColumn } from './rule-compiler';

const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;
const TABLE_NAME = /^[rv]_[a-z0-9]{10}_[a-z0-9]{8}$/;
const SCHEMA_NAME = /^t_[a-z0-9]{8,12}$/;

/** Table aliases used by every quality query: t = typed version table, r = raw table. */
export const TYPED_ALIAS = 't';
export const RAW_ALIAS = 'r';

export function assertTableName(name: string): string {
  if (!TABLE_NAME.test(name)) throw new Error('Unexpected data-plane table name in metadata');
  return name;
}

/** "t_abc"."v_xyz" – both parts validated server-generated names. */
export function qualifiedTable(schema: string, table: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error('Unexpected tenant schema name');
  return `"${schema}"."${assertTableName(table)}"`;
}

/**
 * Maps a version's columns to SQL references for rule compilation. Import versions keep their
 * raw table with the same physical column names. (Cleaning versions, Phase 3b, record their own
 * mapping.)
 */
export function versionColumns(
  columns: { name: string; physicalName: string; dataType: ColumnDataType }[],
  hasRaw: boolean,
): Map<string, VersionColumn> {
  return new Map(
    columns.map((c) => {
      if (!PHYSICAL_NAME.test(c.physicalName))
        throw new Error('Unexpected column identifier in metadata');
      return [
        c.name,
        {
          name: c.name,
          dataType: c.dataType,
          typedSql: `${TYPED_ALIAS}."${c.physicalName}"`,
          rawSql: hasRaw ? `${RAW_ALIAS}."${c.physicalName}"` : null,
        },
      ];
    }),
  );
}
