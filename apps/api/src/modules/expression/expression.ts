/**
 * Expression DSL (decision D-10): the only way users express conditions and derived values
 * (quality consistency rules, cleaning conditions, later semantic filters). Users never write
 * SQL. Pipeline: tokenize → parse (Pratt) → type-check against column types → compile to a SQL
 * fragment with server-quoted identifiers and escaped literals.
 *
 * Grammar (informal):
 *   expr     := or
 *   or       := and ('OR' and)*
 *   and      := not ('AND' not)*
 *   not      := 'NOT' not | predicate
 *   predicate:= sum ( cmp sum | 'IS' 'NOT'? 'NULL' | 'NOT'? 'IN' '(' list ')'
 *                   | 'NOT'? 'BETWEEN' sum 'AND' sum | 'NOT'? 'LIKE' string )?
 *   sum      := product (('+'|'-') product)*
 *   product  := unary (('*'|'/') unary)*
 *   unary    := '-' unary | primary
 *   primary  := number | string | 'TRUE' | 'FALSE' | 'NULL' | 'DATE' string | column
 *             | function '(' args ')' | 'CASE' ('WHEN' expr 'THEN' expr)+ ('ELSE' expr)? 'END'
 *             | '(' expr ')'
 */

export type ValueType = 'text' | 'number' | 'boolean' | 'date' | 'timestamp' | 'null';

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** 0-based character offset in the source, when known. */
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

type TokenKind = 'number' | 'string' | 'ident' | 'op' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'IN',
  'BETWEEN',
  'LIKE',
  'TRUE',
  'FALSE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DATE',
]);

const MAX_SOURCE_LENGTH = 2000;
const MAX_DEPTH = 40;

export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ExpressionError(`Expression is longer than ${MAX_SOURCE_LENGTH} characters`);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(source.slice(i))!;
      tokens.push({ kind: 'number', value: match[0], pos: start });
      i += match[0].length;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= source.length) throw new ExpressionError('Unterminated string', start);
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i];
        i++;
      }
      tokens.push({ kind: 'string', value, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'ident', value: match[0], pos: start });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(two)) {
      tokens.push({ kind: 'op', value: two === '<>' ? '!=' : two, pos: start });
      i += 2;
      continue;
    }
    if ('=<>+-*/'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, pos: start });
      i++;
      continue;
    }
    if ('(),'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, pos: start });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${ch}"`, start);
  }
  tokens.push({ kind: 'eof', value: '', pos: source.length });
  return tokens;
}

// ─── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | { kind: 'literal'; type: ValueType; value: string | number | boolean | null; pos: number }
  | { kind: 'column'; name: string; pos: number }
  | { kind: 'unary'; op: '-' | 'NOT'; operand: Node; pos: number }
  | { kind: 'binary'; op: string; left: Node; right: Node; pos: number }
  | { kind: 'isNull'; operand: Node; negated: boolean; pos: number }
  | { kind: 'in'; operand: Node; values: Node[]; negated: boolean; pos: number }
  | { kind: 'between'; operand: Node; low: Node; high: Node; negated: boolean; pos: number }
  | { kind: 'like'; operand: Node; pattern: string; negated: boolean; pos: number }
  | { kind: 'call'; name: string; args: Node[]; pos: number }
  | { kind: 'case'; whens: { when: Node; then: Node }[]; otherwise: Node | null; pos: number };

/** Functions users may call, with how their result type is derived. */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  coalesce: { min: 1, max: 10 },
  nullif: { min: 2, max: 2 },
  lower: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  length: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  date_trunc: { min: 2, max: 2 },
};

const DATE_TRUNC_UNITS = new Set(['day', 'week', 'month', 'quarter', 'year']);

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expr();
    const next = this.peek();
    if (next.kind !== 'eof') throw new ExpressionError(`Unexpected "${next.value}"`, next.pos);
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    this.index++;
    return token;
  }

  private isKeyword(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'ident' && token.value.toUpperCase() === word;
  }

  private acceptKeyword(word: string): boolean {
    if (!this.isKeyword(word)) return false;
    this.index++;
    return true;
  }

  private expectKeyword(word: string): void {
    if (!this.acceptKeyword(word)) {
      const token = this.peek();
      throw new ExpressionError(`Expected ${word}`, token.pos);
    }
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ExpressionError(`Expected "${value}"`, token.pos);
    }
  }

  private nested<T>(parse: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply');
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  private expr(): Node {
    return this.nested(() => this.or());
  }

  private or(): Node {
    let left = this.and();
    while (this.isKeyword('OR')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'OR', left, right: this.and(), pos };
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.isKeyword('AND')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'AND', left, right: this.not(), pos };
    }
    return left;
  }

  private not(): Node {
    if (this.isKeyword('NOT')) {
      const pos = this.next().pos;
      return { kind: 'unary', op: 'NOT', operand: this.nested(() => this.not()), pos };
    }
    return this.predicate();
  }

  private predicate(): Node {
    const left = this.sum();
    const token = this.peek();
    if (token.kind === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      this.next();
      return { kind: 'binary', op: token.value, left, right: this.sum(), pos: token.pos };
    }
    if (this.isKeyword('IS')) {
      const pos = this.next().pos;
      const negated = this.acceptKeyword('NOT');
      this.expectKeyword('NULL');
      return { kind: 'isNull', operand: left, negated, pos };
    }
    const negated =
      this.isKeyword('NOT') && ['IN', 'BETWEEN', 'LIKE'].some((k) => this.isKeyword(k, 1));
    if (negated) this.next();
    if (this.isKeyword('IN')) {
      const pos = this.next().pos;
      this.expectPunct('(');
      const values = [this.sum()];
      while (this.peek().kind === 'punct' && this.peek().value === ',') {
        this.next();
        values.push(this.sum());
      }
      this.expectPunct(')');
      if (values.length > 500) throw new ExpressionError('IN list is too long (max 500)', pos);
      return { kind: 'in', operand: left, values, negated, pos };
    }
    if (this.isKeyword('BETWEEN')) {
      const pos = this.next().pos;
      const low = this.sum();
      this.expectKeyword('AND');
      return { kind: 'between', operand: left, low, high: this.sum(), negated, pos };
    }
    if (this.isKeyword('LIKE')) {
      const pos = this.next().pos;
      const pattern = this.next();
      if (pattern.kind !== 'string')
        throw new ExpressionError('LIKE needs a text pattern', pattern.pos);
      return { kind: 'like', operand: left, pattern: pattern.value, negated, pos };
    }
    return left;
  }

  private sum(): Node {
    let left = this.product();
    while (this.peek().kind === 'op' && ['+', '-'].includes(this.peek().value)) {
      const token = this.next();
      left = { kind: 'binary', op: token.value, left, right: this.product(), pos: token.pos };
    }
    return left;
  }

  private product(): Node {
    let left = this.unary();
    while (this.peek().kind === 'op' && ['*', '/'].includes(this.peek().value)) {
      const token = this.next();
      left = { kind: 'binary', op: token.value, left, right: this.unary(), pos: token.pos };
    }
    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.kind === 'op' && token.value === '-') {
      this.next();
      return { kind: 'unary', op: '-', operand: this.nested(() => this.unary()), pos: token.pos };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.next();
    switch (token.kind) {
      case 'number':
        return { kind: 'literal', type: 'number', value: token.value, pos: token.pos };
      case 'string':
        return { kind: 'literal', type: 'text', value: token.value, pos: token.pos };
      case 'punct':
        if (token.value === '(') {
          const inner = this.expr();
          this.expectPunct(')');
          return inner;
        }
        break;
      case 'ident': {
        const upper = token.value.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') {
          return { kind: 'literal', type: 'boolean', value: upper === 'TRUE', pos: token.pos };
        }
        if (upper === 'NULL') return { kind: 'literal', type: 'null', value: null, pos: token.pos };
        if (upper === 'DATE') {
          const literal = this.next();
          if (
            literal.kind !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(literal.value) ||
            !isRealDate(literal.value)
          ) {
            throw new ExpressionError("DATE needs a literal like DATE '2026-01-31'", literal.pos);
          }
          return { kind: 'literal', type: 'date', value: literal.value, pos: token.pos };
        }
        if (upper === 'CASE') return this.caseExpr(token.pos);
        if (KEYWORDS.has(upper)) break;
        const lower = token.value.toLowerCase();
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          const spec = FUNCTIONS[lower];
          if (!spec) throw new ExpressionError(`Unknown function "${token.value}"`, token.pos);
          this.next();
          const args: Node[] = [];
          if (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            args.push(this.expr());
            while (this.peek().kind === 'punct' && this.peek().value === ',') {
              this.next();
              args.push(this.expr());
            }
          }
          this.expectPunct(')');
          if (args.length < spec.min || args.length > spec.max) {
            throw new ExpressionError(`Wrong number of arguments for ${lower}`, token.pos);
          }
          return { kind: 'call', name: lower, args, pos: token.pos };
        }
        return { kind: 'column', name: lower, pos: token.pos };
      }
      default:
        break;
    }
    throw new ExpressionError(
      token.kind === 'eof' ? 'Unexpected end of expression' : `Unexpected "${token.value}"`,
      token.pos,
    );
  }

  private caseExpr(pos: number): Node {
    const whens: { when: Node; then: Node }[] = [];
    while (this.acceptKeyword('WHEN')) {
      const when = this.expr();
      this.expectKeyword('THEN');
      whens.push({ when, then: this.expr() });
    }
    if (whens.length === 0) throw new ExpressionError('CASE needs at least one WHEN', pos);
    const otherwise = this.acceptKeyword('ELSE') ? this.expr() : null;
    this.expectKeyword('END');
    return { kind: 'case', whens, otherwise, pos };
  }
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseExpression(source: string): Node {
  const trimmed = source.trim();
  if (trimmed === '') throw new ExpressionError('Expression is empty');
  return new Parser(tokenize(trimmed)).parse();
}

// ─── Type checking ───────────────────────────────────────────────────────────

export interface ColumnBinding {
  type: Exclude<ValueType, 'null'>;
  /** SQL to reference the column, already quoted (e.g. "c_3" or t."c_3"). */
  sql: string;
}

export type Scope = (name: string) => ColumnBinding | undefined;

const comparable = (a: ValueType, b: ValueType) =>
  a === 'null' ||
  b === 'null' ||
  a === b ||
  (a === 'date' && b === 'timestamp') ||
  (a === 'timestamp' && b === 'date');

function unify(types: ValueType[], pos: number, what: string): ValueType {
  const concrete = types.filter((t) => t !== 'null');
  if (concrete.length === 0) return 'null';
  const first = concrete[0]!;
  for (const t of concrete) {
    if (!comparable(first, t))
      throw new ExpressionError(`${what}: cannot mix ${first} and ${t}`, pos);
  }
  return concrete.includes('timestamp') ? 'timestamp' : first;
}

export function typeOf(node: Node, scope: Scope): ValueType {
  switch (node.kind) {
    case 'literal':
      return node.type;
    case 'column': {
      const binding = scope(node.name);
      if (!binding) throw new ExpressionError(`Unknown column "${node.name}"`, node.pos);
      return binding.type;
    }
    case 'unary': {
      const t = typeOf(node.operand, scope);
      const expected = node.op === 'NOT' ? 'boolean' : 'number';
      if (t !== expected && t !== 'null') {
        throw new ExpressionError(`${node.op} needs a ${expected} value, got ${t}`, node.pos);
      }
      return expected;
    }
    case 'binary': {
      const l = typeOf(node.left, scope);
      const r = typeOf(node.right, scope);
      if (node.op === 'AND' || node.op === 'OR') {
        for (const t of [l, r]) {
          if (t !== 'boolean' && t !== 'null') {
            throw new ExpressionError(`${node.op} needs true/false values, got ${t}`, node.pos);
          }
        }
        return 'boolean';
      }
      if (['+', '-', '*', '/'].includes(node.op)) {
        for (const t of [l, r]) {
          if (t !== 'number' && t !== 'null') {
            throw new ExpressionError(`"${node.op}" needs numbers, got ${t}`, node.pos);
          }
        }
        return 'number';
      }
      if (!comparable(l, r)) throw new ExpressionError(`Cannot compare ${l} with ${r}`, node.pos);
      if (['<', '<=', '>', '>='].includes(node.op) && (l === 'boolean' || r === 'boolean')) {
        throw new ExpressionError('True/false values cannot be ordered', node.pos);
      }
      return 'boolean';
    }
    case 'isNull':
      typeOf(node.operand, scope);
      return 'boolean';
    case 'in':
      unify(
        [typeOf(node.operand, scope), ...node.values.map((v) => typeOf(v, scope))],
        node.pos,
        'IN',
      );
      return 'boolean';
    case 'between': {
      const t = unify(
        [typeOf(node.operand, scope), typeOf(node.low, scope), typeOf(node.high, scope)],
        node.pos,
        'BETWEEN',
      );
      if (t === 'boolean' || t === 'text') {
        throw new ExpressionError('BETWEEN needs numbers or dates', node.pos);
      }
      return 'boolean';
    }
    case 'like': {
      const t = typeOf(node.operand, scope);
      if (t !== 'text' && t !== 'null')
        throw new ExpressionError('LIKE needs a text value', node.pos);
      return 'boolean';
    }
    case 'call':
      return typeOfCall(node, scope);
    case 'case': {
      for (const { when } of node.whens) {
        const t = typeOf(when, scope);
        if (t !== 'boolean' && t !== 'null')
          throw new ExpressionError('WHEN needs a condition', when.pos);
      }
      const results = node.whens.map((w) => typeOf(w.then, scope));
      if (node.otherwise) results.push(typeOf(node.otherwise, scope));
      return unify(results, node.pos, 'CASE');
    }
  }
}

function typeOfCall(node: Extract<Node, { kind: 'call' }>, scope: Scope): ValueType {
  const args = node.args.map((a) => typeOf(a, scope));
  const need = (index: number, ...allowed: ValueType[]) => {
    const t = args[index]!;
    if (t !== 'null' && !allowed.includes(t)) {
      throw new ExpressionError(
        `${node.name}() argument ${index + 1} must be ${allowed.join(' or ')}`,
        node.pos,
      );
    }
  };
  switch (node.name) {
    case 'coalesce':
      return unify(args, node.pos, 'coalesce');
    case 'nullif':
      return unify(args, node.pos, 'nullif');
    case 'lower':
    case 'upper':
    case 'trim':
      need(0, 'text');
      return 'text';
    case 'length':
      need(0, 'text');
      return 'number';
    case 'abs':
      need(0, 'number');
      return 'number';
    case 'round':
      need(0, 'number');
      if (args.length === 2) {
        const digits = node.args[1]!;
        if (
          digits.kind !== 'literal' ||
          digits.type !== 'number' ||
          !/^\d+$/.test(String(digits.value))
        ) {
          throw new ExpressionError('round() digits must be a whole number literal', node.pos);
        }
      }
      return 'number';
    case 'date_trunc': {
      const unit = node.args[0]!;
      if (
        unit.kind !== 'literal' ||
        unit.type !== 'text' ||
        !DATE_TRUNC_UNITS.has(String(unit.value))
      ) {
        throw new ExpressionError(
          `date_trunc() unit must be one of ${[...DATE_TRUNC_UNITS].join(', ')}`,
          node.pos,
        );
      }
      need(1, 'date', 'timestamp');
      return args[1] === 'date' ? 'date' : 'timestamp';
    }
    default:
      throw new ExpressionError(`Unknown function "${node.name}"`, node.pos);
  }
}

// ─── SQL compilation ─────────────────────────────────────────────────────────

/** PostgreSQL string literal, escaped like pg's escapeLiteral (E'' form when backslashes occur). */
export function sqlString(value: string): string {
  const cleaned = value.replaceAll('\u0000', '');
  const hasBackslash = cleaned.includes('\\');
  const escaped = cleaned.replace(/'/g, "''").replace(/\\/g, '\\\\');
  return `${hasBackslash ? 'E' : ''}'${escaped}'`;
}

const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function compileLiteral(node: Extract<Node, { kind: 'literal' }>): string {
  switch (node.type) {
    case 'number': {
      const text = String(node.value);
      if (!NUMBER.test(text)) throw new ExpressionError('Invalid number', node.pos);
      return `${text}::numeric`;
    }
    case 'text':
      return `${sqlString(String(node.value))}::text`;
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'date':
      return `DATE ${sqlString(String(node.value))}`;
    default:
      return 'NULL';
  }
}

/** Compiles a type-checked AST to a SQL fragment. Every identifier comes from `scope`. */
export function compile(node: Node, scope: Scope): string {
  const c = (n: Node) => compile(n, scope);
  switch (node.kind) {
    case 'literal':
      return compileLiteral(node);
    case 'column': {
      const binding = scope(node.name);
      if (!binding) throw new ExpressionError(`Unknown column "${node.name}"`, node.pos);
      return binding.sql;
    }
    case 'unary':
      return node.op === 'NOT' ? `(NOT ${c(node.operand)})` : `(-${c(node.operand)})`;
    case 'binary': {
      const op = node.op === '!=' ? '<>' : node.op;
      // Division by zero yields NULL instead of aborting the whole quality check.
      if (op === '/') return `(${c(node.left)} / NULLIF(${c(node.right)}, 0))`;
      return `(${c(node.left)} ${op} ${c(node.right)})`;
    }
    case 'isNull':
      return `(${c(node.operand)} IS ${node.negated ? 'NOT ' : ''}NULL)`;
    case 'in':
      return `(${c(node.operand)} ${node.negated ? 'NOT ' : ''}IN (${node.values.map(c).join(', ')}))`;
    case 'between':
      return `(${c(node.operand)} ${node.negated ? 'NOT ' : ''}BETWEEN ${c(node.low)} AND ${c(node.high)})`;
    case 'like':
      return `(${c(node.operand)} ${node.negated ? 'NOT ' : ''}LIKE ${sqlString(node.pattern)})`;
    case 'call': {
      if (node.name === 'date_trunc') {
        return `date_trunc(${sqlString(String((node.args[0] as Extract<Node, { kind: 'literal' }>).value))}, ${c(node.args[1]!)})`;
      }
      if (node.name === 'round' && node.args.length === 2) {
        const digits = String((node.args[1] as Extract<Node, { kind: 'literal' }>).value);
        return `round((${c(node.args[0]!)})::numeric, ${Number.parseInt(digits, 10)})`;
      }
      return `${node.name}(${node.args.map(c).join(', ')})`;
    }
    case 'case': {
      const whens = node.whens.map((w) => `WHEN ${c(w.when)} THEN ${c(w.then)}`).join(' ');
      return `(CASE ${whens}${node.otherwise ? ` ELSE ${c(node.otherwise)}` : ''} END)`;
    }
  }
}

export interface CompiledExpression {
  sql: string;
  type: ValueType;
  /** Columns referenced, by name. */
  columns: string[];
}

function collectColumns(node: Node, into: Set<string>): void {
  switch (node.kind) {
    case 'column':
      into.add(node.name);
      break;
    case 'unary':
    case 'isNull':
    case 'like':
      collectColumns(node.operand, into);
      break;
    case 'binary':
      collectColumns(node.left, into);
      collectColumns(node.right, into);
      break;
    case 'in':
      collectColumns(node.operand, into);
      node.values.forEach((v) => collectColumns(v, into));
      break;
    case 'between':
      [node.operand, node.low, node.high].forEach((n) => collectColumns(n, into));
      break;
    case 'call':
      node.args.forEach((a) => collectColumns(a, into));
      break;
    case 'case':
      node.whens.forEach((w) => {
        collectColumns(w.when, into);
        collectColumns(w.then, into);
      });
      if (node.otherwise) collectColumns(node.otherwise, into);
      break;
    default:
      break;
  }
}

/** Parse + type-check + compile in one step. */
export function compileExpression(
  source: string,
  scope: Scope,
  expected?: Exclude<ValueType, 'null'>,
): CompiledExpression {
  const ast = parseExpression(source);
  const type = typeOf(ast, scope);
  if (expected && type !== expected && type !== 'null') {
    throw new ExpressionError(`Expression must produce ${expected}, but produces ${type}`);
  }
  const columns = new Set<string>();
  collectColumns(ast, columns);
  return { sql: compile(ast, scope), type, columns: [...columns] };
}
