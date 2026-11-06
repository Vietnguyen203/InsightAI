# Architecture guardrails

What Claude must not change without the user's explicit approval. Each row names the area, where
it lives and the decision that defines it; the decision text (`docs/DECISIONS.md`) and design
documents remain the source of truth – this file only points to them.

Invariants in short: `.specify/memory/constitution.md`. Workflow: `DEVELOPMENT.md`.

## Protected areas

| Area | Where it lives | Source |
|---|---|---|
| Modular monolith + worker (one codebase, API + BullMQ worker; no new services/processes) | `apps/api/src/main.ts`, `src/worker.ts`, `src/worker.module.ts` | D-01, D-02 |
| Module boundaries and dependency direction (modules use `platform/*`; module → module only through exported services, no cycles) | `apps/api/src/modules/*/*.module.ts`, `apps/api/src/platform/` | D-01 |
| Shared contracts (all request/response shapes, Zod; build before api/web) | `packages/contracts/src/` | D-02, `CLAUDE.md` |
| Request validation (Zod pipe, not class-validator DTOs) and RFC 7807 errors with stable codes | `platform/http/zod.ts`, `platform/errors/app-error.ts`, `contracts/src/problem.ts` | `CLAUDE.md` |
| API contracts (existing paths, fields and error codes stay backward compatible) | controllers, `docs/API_DOCUMENTATION.md` | `CLAUDE.md` |
| Authentication (access JWT, refresh rotation in httpOnly cookie, CSRF header) | `modules/auth/`, `apps/web/src/lib/session.ts` | D-14, D-21, D-25 |
| Authorization (system roles, permissions read per request, `@RequirePermissions`) | `modules/iam/`, `platform/http/decorators.ts` | D-24 |
| Metadata database ownership (schema `app`, owner role runs migrations, app role has no BYPASSRLS) | `apps/api/prisma/`, `apps/api/scripts/bootstrap-db.mjs` | D-05, D-06 |
| Migrations (only new Prisma migrations; never edit applied ones) | `apps/api/prisma/migrations/` | `CLAUDE.md` |
| RLS FORCE on every tenant/user table; context via `runInTenant/runInContext` only | `platform/prisma/prisma.service.ts`, migrations | D-06, D-22, D-49, D-52 |
| Tenant data plane (schema `t_*` per tenant, `SET LOCAL ROLE` reader/writer, provisioning role) | `platform/data-plane/` | D-04, D-06, D-23 |
| Datasets and versions (typed tables, copy-on-write versions, cleaning never auto-activates) | `modules/dataset`, `import`, `cleaning` | D-04, D-29, D-36–D-38 |
| Expression DSL (escaped literals, type-checked) | `modules/expression/` | D-10, D-33 |
| Semantic layer (draft + immutable published snapshot, validation, metrics with immutable versions, synonyms) | `modules/semantic/` | D-07, D-40, D-41, D-45, D-46 |
| Semantic Query IR and planner (fan-out safe, many-to-one joins only, bound parameters) | `contracts/src/semantic-query.ts`, `modules/query-engine/query-planner.ts` | D-03, D-42 |
| SQL validator (libpg-query; single SELECT, allow-listed functions, tenant schema only) | `modules/query-engine/sql-validator.ts` | D-43 |
| Access policies, query cache keys (include org, SQL, policies, versions), query history | `modules/query-engine/access-policy-rules.ts`, `query-engine.service.ts` | D-44 |
| AI Q&A pipeline (tool calling, strict tool schemas, placeholders + number guard, rule-based charts, quota) | `modules/ai/` | D-03, D-08, D-47, D-48 |
| `aiDataSharing` (default METADATA_ONLY: no data values to the provider) | `modules/ai/ai.service.ts`, `organizations.ai_data_sharing` | D-50 |
| Analysis Plan IR, plan validator, planner (metadata only) | `contracts/src/investigation.ts`, `modules/investigation/plan-validator.ts`, `planner.service.ts` | D-52 |
| Investigation orchestrator (persisted state machine, resume, budgets, pinned versions, author's permissions per step) | `modules/investigation/orchestrator.service.ts`, `investigation.processor.ts` | D-52 |
| Analytical engines (exact decimals, deterministic statistics) | `modules/investigation/analysis/` | D-51 |
| Evidence, hypotheses, findings (evidence append-only, never remapped; rules never causal) | `modules/investigation/evidence.service.ts`, `validation/` | D-53 |
| Dashboards (PRIVATE/ORG by RLS, widgets store IR, run as viewer) | `modules/dashboard/`, `apps/web/src/features/dashboards/` | D-49 |
| Queues and Redis (BullMQ queues, deterministic job ids, `QUEUE_PREFIX`, Redis auth in production) | `platform/queue/`, `docker/compose.prod.yml` | D-50, D-52 |
| Object storage (S3 API; SeaweedFS in dev/CI, external S3 in production; uploads through the API) | `platform/storage/` | D-20, D-26 |
| Production deployment and backups (images, Caddy, global roles in backups) | `docker/`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md` | D-50 |
| Frontend stack and conventions (React 19, Vite, Tailwind, TanStack Query, `orgKey`, `usePermission`, vi + en) | `apps/web/` | D-15, D-17, D-25, `CLAUDE.md` |

## Change protocol

Before proposing a change to any area above, Claude must write down, and get the user's approval
for:

1. **Existing implementation** – the files and decisions involved (cite D-xx).
2. **Problem** – what fails or is missing, with evidence.
3. **Why the current architecture cannot solve it** – including the smallest change inside it.
4. **Alternatives** – at least one, with trade-offs.
5. **Migration risks** – data, security (RLS, tenant isolation, AI safety), operations.
6. **Backward compatibility** – API, contracts, stored data, existing tests.
7. **Approval** – no implementation until the user approves; the result is recorded as a new D-xx.

Never, even with a plausible reason and without approval: bypass RLS or the data-plane roles, let
the LLM produce SQL or figures, send data values to the AI provider in METADATA_ONLY mode, edit an
applied migration, or weaken an existing test to make a change pass.
