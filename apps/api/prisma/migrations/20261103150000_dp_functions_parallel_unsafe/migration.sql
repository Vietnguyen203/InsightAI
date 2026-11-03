-- The dp.try_* functions use PL/pgSQL EXCEPTION blocks, which open subtransactions. Those are
-- not allowed inside parallel workers, so on large tables (where the planner picks a parallel
-- plan) imports failed with "cannot start subtransactions during a parallel operation".
-- Found by the 200k-row import performance test.
ALTER FUNCTION dp.try_bigint(text) PARALLEL UNSAFE;
ALTER FUNCTION dp.try_numeric(text) PARALLEL UNSAFE;
ALTER FUNCTION dp.try_date(text, text) PARALLEL UNSAFE;
ALTER FUNCTION dp.try_timestamp(text, text) PARALLEL UNSAFE;
ALTER FUNCTION dp.try_timestamp_iso(text, text) PARALLEL UNSAFE;
