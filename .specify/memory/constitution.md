# InsightAI Constitution

Invariants every Spec Kit plan must respect. This file only states them and points to their
source; the details live in `CLAUDE.md`, `docs/DECISIONS.md` (D-xx) and the design documents.
Protected areas and the change protocol: `docs/ai-workflow/ARCHITECTURE-GUARDRAILS.md`.

## Core Principles

### I. Modular monolith + worker

One NestJS codebase, two processes: API (`apps/api/src/main.ts`) and BullMQ worker
(`src/worker.ts`) (D-01, D-02). New capabilities are modules in `apps/api/src/modules/`; no new
services, processes or frameworks. Request/response shapes live in `packages/contracts` (Zod).

### II. Tenant isolation is never relaxed (NON-NEGOTIABLE)

Metadata is reached only through `PrismaService.runInTenant/runInContext` under PostgreSQL RLS
FORCE; tenant data only through `DataPlaneService.withTenantRead/Write` (per-tenant schema and
role) (D-04, D-06, D-22). No code path, cache key, job or AI feature may bypass this.

### III. The LLM never writes SQL and never produces figures (NON-NEGOTIABLE)

The LLM proposes a Semantic Query IR or an Analysis Plan IR only (D-03, D-47, D-52). SQL is
compiled deterministically, validated with libpg-query and run with the caller's permissions and
access policies (D-42–D-44). Every number shown comes from query results or deterministic
engines (D-47, D-51, D-53). What the AI provider may receive follows `aiDataSharing` (D-50).

### IV. Correct, versioned data

Priorities: data correctness > data quality > semantic consistency > security > AI accuracy >
UX > scale (`CLAUDE.md`). Published models, metric versions and investigation evidence are
immutable; results are never silently remapped to newer definitions (D-40, D-45, D-53). Schema
changes only through new Prisma migrations, never by editing applied ones.

### V. Reliable background work

Jobs are idempotent, keyed by deterministic ids, with PostgreSQL as the source of truth;
retries and failures are handled explicitly (`apps/api/src/platform/queue/queues.ts`, D-52). A
worker runs every job as the user or tenant it belongs to.

### VI. Simplicity and scope

Follow the surrounding code; no unrelated refactors, speculative abstractions or unneeded
dependencies. Work phase by phase per `docs/DEVELOPMENT_PLAN.md`; ideas outside the MVP go to
`docs/FUTURE_ROADMAP.md`.

### VII. Verified, honest delivery

Every change ships with the tests its risk calls for: unit tests for logic, integration tests
for database/module behaviour, tenant-isolation tests for data access, AI-safety tests for the
LLM path. Results are reported as actually run; unrun checks are never claimed.

## Quality Gates

A plan passes the Constitution Check only if it answers yes to all of:

1. Fits an existing module (or adds one) without a new process, framework or service?
2. Uses `runInContext` / `withTenant*` for all data access, with RLS and policies intact?
3. Keeps SQL out of the LLM path and every figure deterministic?
4. Changes the database only through a new migration, and API shapes only through
   `packages/contracts` with a stated compatibility impact?
5. Names the tests (unit / integration / isolation / AI-safety) that will prove it?
6. Lists the docs to update per `CLAUDE.md` (STATUS, DECISIONS, API, DATABASE_DESIGN)?

A "no" needs the guardrail change protocol and the user's approval before implementation.

## Governance

`CLAUDE.md` and the accepted decisions in `docs/DECISIONS.md` take precedence over this file.
Amending a principle requires a new D-xx decision approved by the user, then an update here
(semantic versioning: MAJOR for a removed or redefined principle, MINOR for an added one, PATCH
for wording). Conflicts between sources are raised to the user, never resolved silently.

**Version**: 1.0.0 | **Ratified**: 2026-11-06 | **Last Amended**: 2026-11-06
