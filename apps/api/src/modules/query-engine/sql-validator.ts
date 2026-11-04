import { loadModule, parseSync, scanSync } from 'libpg-query';

/**
 * Defense in depth for generated SQL (docs/SEMANTIC_LAYER_DESIGN.md §6.4): the statement is parsed
 * with PostgreSQL's own parser (libpg-query) and must be a single read-only SELECT over the
 * planned tables of the tenant schema, calling only allow-listed functions. This catches compiler
 * bugs and closes D-06 (no SET ROLE / set_config can get through) independently of the planner.
 */

export class SqlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlRejected';
  }
}

const ALLOWED_FUNCTIONS = new Set([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'date_trunc',
  'coalesce',
  'nullif',
  'lower',
  'upper',
  'btrim',
  'ltrim',
  'rtrim',
  'length',
  'char_length',
  'abs',
  'round',
  'trim_scale',
]);

const ALLOWED_TYPES = new Set([
  'text',
  'numeric',
  'int8',
  'int4',
  'bool',
  'date',
  'timestamp',
  'varchar',
  'bpchar',
]);

/** Statement node types that may never appear (DML/DDL/utility, also inside CTEs). */
const FORBIDDEN_NODE = /Stmt$/;

let ready: Promise<void> | null = null;
/** Loads the WASM parser once; call before validating. */
export function initSqlValidator(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

export interface ValidationScope {
  /** Tenant schema every table must belong to. */
  schema: string;
  /** Tables the plan uses (unquoted names). */
  tables: Set<string>;
}

export function validateSql(sql: string, scope: ValidationScope): void {
  let tree: { stmts?: { stmt: Record<string, unknown> }[] };
  try {
    tree = parseSync(sql) as typeof tree;
  } catch {
    throw new SqlRejected('The generated SQL does not parse');
  }

  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) throw new SqlRejected('Exactly one statement is allowed');
  const root = stmts[0]!.stmt;
  if (Object.keys(root)[0] !== 'SelectStmt') throw new SqlRejected('Only SELECT is allowed');

  for (const token of (scanSync(sql) as { tokens?: { tokenName?: string }[] }).tokens ?? []) {
    if (token.tokenName === 'SQL_COMMENT' || token.tokenName === 'C_COMMENT') {
      throw new SqlRejected('Comments are not allowed');
    }
  }

  // CTE names first: the FROM clause is visited before the WITH clause.
  const cteNames = new Set<string>();
  JSON.stringify(root, (k, v: unknown) => {
    if (k === 'CommonTableExpr') {
      const name = (v as { ctename?: string }).ctename;
      if (name) cteNames.add(name);
    }
    return v;
  });
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const [type, value] of Object.entries(record)) {
      if (FORBIDDEN_NODE.test(type) && type !== 'SelectStmt') {
        throw new SqlRejected(`${type} is not allowed`);
      }
      switch (type) {
        case 'SelectStmt': {
          const select = value as Record<string, unknown>;
          if (select.intoClause) throw new SqlRejected('SELECT INTO is not allowed');
          if (select.lockingClause) throw new SqlRejected('Row locking is not allowed');
          break;
        }
        case 'CommonTableExpr': {
          const cte = value as { ctequery?: Record<string, unknown> };
          if (cte.ctequery && Object.keys(cte.ctequery)[0] !== 'SelectStmt') {
            throw new SqlRejected('Only SELECT is allowed in WITH');
          }
          break;
        }
        case 'RangeVar':
          checkTable(value as { schemaname?: string; relname?: string }, scope, cteNames);
          break;
        case 'FuncCall': {
          const names = nameParts((value as { funcname?: unknown[] }).funcname);
          const fn = names.at(-1) ?? '';
          const qualified = names.length > 1 && !(names.length === 2 && names[0] === 'pg_catalog');
          if (qualified || !ALLOWED_FUNCTIONS.has(fn)) {
            throw new SqlRejected(`Function "${names.join('.')}" is not allowed`);
          }
          break;
        }
        case 'TypeCast': {
          const names = nameParts((value as { typeName?: { names?: unknown[] } }).typeName?.names);
          const typeName = names.at(-1) ?? '';
          if ((names.length > 1 && names[0] !== 'pg_catalog') || !ALLOWED_TYPES.has(typeName)) {
            throw new SqlRejected(`Type "${names.join('.')}" is not allowed`);
          }
          break;
        }
        case 'SQLValueFunction':
        case 'RangeFunction':
        case 'RangeTableFunc':
        case 'XmlExpr':
          throw new SqlRejected(`${type} is not allowed`);
        default:
          break;
      }
      visit(value);
    }
  };
  visit(root);
}

function checkTable(
  table: { schemaname?: string; relname?: string },
  scope: ValidationScope,
  cteNames: Set<string>,
) {
  const relname = table.relname ?? '';
  if (!table.schemaname) {
    // Unqualified names may only refer to the query's own CTEs.
    if (!cteNames.has(relname)) throw new SqlRejected(`Table "${relname}" is not allowed`);
    return;
  }
  if (table.schemaname !== scope.schema || !scope.tables.has(relname)) {
    throw new SqlRejected(`Table "${table.schemaname}.${relname}" is not allowed`);
  }
}

function nameParts(list: unknown[] | undefined): string[] {
  return (list ?? []).map((n) => (n as { String?: { sval?: string } }).String?.sval ?? '');
}
