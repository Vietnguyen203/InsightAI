import { describe, expect, it } from 'vitest';
import {
  type ColumnBinding,
  compileExpression,
  ExpressionError,
  parseExpression,
  type Scope,
  sqlString,
} from './expression';

const columns: Record<string, ColumnBinding> = {
  payment_status: { type: 'text', sql: '"c_1"' },
  paid_at: { type: 'timestamp', sql: '"c_2"' },
  created_at: { type: 'date', sql: '"c_3"' },
  total_amount: { type: 'number', sql: '"c_4"' },
  quantity: { type: 'number', sql: '"c_5"' },
  unit_price: { type: 'number', sql: '"c_6"' },
  is_vip: { type: 'boolean', sql: '"c_7"' },
};
const scope: Scope = (name) => columns[name];
const sql = (source: string) => compileExpression(source, scope).sql;

describe('expression DSL', () => {
  describe('compiles business rules', () => {
    it('comparisons between columns', () => {
      expect(sql('paid_at >= created_at')).toBe('("c_2" >= "c_3")');
    });

    it('conditional consistency rules', () => {
      expect(sql("CASE WHEN payment_status = 'PAID' THEN paid_at IS NOT NULL ELSE TRUE END")).toBe(
        `(CASE WHEN ("c_1" = 'PAID'::text) THEN ("c_2" IS NOT NULL) ELSE true END)`,
      );
    });

    it('arithmetic with tolerance', () => {
      expect(sql('abs(total_amount - quantity * unit_price) <= 0.01')).toBe(
        '(abs(("c_4" - ("c_5" * "c_6"))) <= 0.01::numeric)',
      );
    });

    it('division never fails on zero', () => {
      expect(sql('total_amount / quantity > 0')).toBe('(("c_4" / NULLIF("c_5", 0)) > 0::numeric)');
    });

    it('IN, BETWEEN, LIKE, NOT and case-insensitive keywords', () => {
      expect(sql("payment_status not in ('PAID', 'REFUNDED')")).toBe(
        `("c_1" NOT IN ('PAID'::text, 'REFUNDED'::text))`,
      );
      expect(sql("created_at between date '2026-01-01' and date '2026-12-31'")).toBe(
        `("c_3" BETWEEN DATE '2026-01-01' AND DATE '2026-12-31')`,
      );
      expect(sql("lower(payment_status) LIKE 'pa%'")).toBe(`(lower("c_1") LIKE 'pa%')`);
      expect(sql('NOT is_vip OR quantity > 10')).toBe('((NOT "c_7") OR ("c_5" > 10::numeric))');
    });

    it('operator precedence', () => {
      expect(sql('quantity + unit_price * 2 > 5 AND is_vip = TRUE OR quantity < 0')).toBe(
        '(((("c_5" + ("c_6" * 2::numeric)) > 5::numeric) AND ("c_7" = true)) OR ("c_5" < 0::numeric))',
      );
    });

    it('date_trunc and round', () => {
      expect(sql("date_trunc('month', paid_at) = date_trunc('month', created_at)")).toBe(
        `(date_trunc('month', "c_2") = date_trunc('month', "c_3"))`,
      );
      expect(sql('round(total_amount, 2) = total_amount')).toBe(
        '(round(("c_4")::numeric, 2) = "c_4")',
      );
    });

    it('reports referenced columns and result type', () => {
      const result = compileExpression('paid_at >= created_at', scope, 'boolean');
      expect(result).toMatchObject({ type: 'boolean', columns: ['paid_at', 'created_at'] });
    });
  });

  describe('rejects invalid input with a position', () => {
    const fails = (source: string, message: RegExp) => {
      try {
        compileExpression(source, scope);
        expect.unreachable(`should fail: ${source}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
        expect((error as Error).message).toMatch(message);
      }
    };

    it('unknown columns and functions', () => {
      fails('price > 0', /Unknown column "price"/);
      fails('pg_sleep(10) IS NULL', /Unknown function "pg_sleep"/);
      fails("set_config('role', 'x', true) IS NULL", /Unknown function/);
    });

    it('type errors', () => {
      fails("total_amount = 'abc'", /Cannot compare number with text/);
      fails('payment_status + 1 > 0', /needs numbers/);
      fails('is_vip > FALSE', /cannot be ordered/);
      fails("date_trunc('hour', paid_at) IS NULL", /unit must be one of/);
      fails("created_at = DATE '2026-02-31'", /DATE needs a literal/);
    });

    it('syntax errors', () => {
      fails('quantity >', /Unexpected end/);
      fails("payment_status = 'PAID", /Unterminated string/);
      fails('quantity > 1;', /Unexpected character ";"/);
      // "--" is two minus operators, never a SQL comment.
      fails('quantity > 1 -- comment', /Unknown column "comment"/);
      fails('CASE END', /at least one WHEN/);
      fails('', /empty/);
    });

    it('requires the expected result type', () => {
      expect(() => compileExpression('quantity * 2', scope, 'boolean')).toThrow(
        /must produce boolean/,
      );
    });

    it('limits size and nesting', () => {
      expect(() => parseExpression('('.repeat(60) + '1' + ')'.repeat(60))).toThrow(
        /nested too deeply/,
      );
      expect(() => parseExpression(`quantity > ${'1'.repeat(3000)}`)).toThrow(/longer than/);
    });
  });

  describe('cannot be used to inject SQL', () => {
    it('keeps quotes inside string literals', () => {
      expect(sql("payment_status = 'x''; DROP TABLE app.users; --'")).toBe(
        `("c_1" = 'x''; DROP TABLE app.users; --'::text)`,
      );
    });

    it('escapes backslashes with the E-string form', () => {
      expect(sqlString("a\\'b")).toBe("E'a\\\\''b'");
    });

    it('never produces a SQL comment marker', () => {
      const out = sql('quantity - -1 > 0');
      expect(out).toBe('(("c_5" - (-1::numeric)) > 0::numeric)');
      expect(out).not.toContain('--');
    });

    it('never emits identifiers from the source text', () => {
      // A column-looking token can only become a binding from the scope.
      expect(() => sql('"c_1" = 1')).toThrow(ExpressionError);
      expect(() => sql('app.users IS NULL')).toThrow(/Unexpected character "."/);
    });
  });
});
