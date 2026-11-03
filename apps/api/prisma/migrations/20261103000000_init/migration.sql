-- Phase 1 foundation: extensions used by later phases (all are "trusted" extensions,
-- so the schema owner can create them without superuser).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Schema "app" is created by scripts/bootstrap-db.mjs (it must exist before Prisma can
-- create its migrations table there). Kept here so a fresh database stays consistent.
CREATE SCHEMA IF NOT EXISTS app;
