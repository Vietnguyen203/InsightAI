# InsightAI – instructions for Claude

AI-powered BI & data analytics SaaS (multi-tenant). Language with the user: Vietnamese.
Stack: pnpm monorepo · `apps/api` NestJS 11 + Prisma 7 (PostgreSQL 16) + BullMQ/Redis + S3 (SeaweedFS)
· `apps/web` React 19 + Vite 7 + Tailwind 4 + TanStack Query + i18next (vi default, en)
· `packages/contracts` shared Zod schemas (build before api/web) · Docker Compose · GitHub Actions.

## Start here

- Read `docs/STATUS.md` first, then only the task's module files. Design sources in `docs/*.md`
  (relevant section only, never copy here): ARCHITECTURE, DATABASE_DESIGN, DATA_QUALITY_DESIGN,
  SEMANTIC_LAYER_DESIGN, DECISIONS (D-xx), API_DOCUMENTATION, DEVELOPMENT_PLAN, FUTURE_ROADMAP.

## Principles & scope

- Modular monolith + background worker (`src/main.ts` API, `src/worker.ts` BullMQ consumers).
- Priorities: data correctness > data quality > semantic consistency > security > AI accuracy > UX > scale.
- LLM never writes SQL: it produces a Semantic Query IR (D-03). Own semantic layer (D-07), OpenAI (D-08).
- Work phase by phase per `DEVELOPMENT_PLAN.md`; never start the next phase without the user's go.
  No scope creep: ideas outside the MVP go to `docs/FUTURE_ROADMAP.md`, not into code.

## Module map

- API `apps/api/src/modules/`: auth, iam, organization, audit, dataset, import, profiling,
  expression (DSL), quality, cleaning, semantic, query-engine, health. Infra in `src/platform/` (config, prisma,
  data-plane, queue, storage, errors, http). Migrations `apps/api/prisma/migrations/`.
- Web `apps/web/src/features/`: auth, organizations, settings, overview, system, datasets, quality, semantic.
  Shared UI `src/components/ui`, helpers `src/lib`, texts `src/i18n/locales/{vi,en}.json`.

## Conventions

- TypeScript strict; follow the surrounding code; no unrelated refactors or unneeded dependencies.
- Request/response shapes live in `packages/contracts`; API errors are RFC 7807 with stable codes.
- DB changes only through new Prisma migrations (never edit applied ones). Metadata in schema `app`.
- Frontend: reuse components/tokens, handle loading/empty/error states, every text in vi AND en,
  tenant query keys via `orgKey(...)`, permissions via `usePermission`.

## Security & tenant isolation

- Metadata: PostgreSQL RLS (FORCE) via `PrismaService.runInTenant/runInContext`; never bypass.
- Tenant data: per-tenant schema `t_*` accessed only through `DataPlaneService.withTenantRead/Write`.
- Identifiers in SQL come from metadata and are re-validated; user values are escaped/validated.
- Never expose secrets (`.env` is local only); no destructive DB/git operations without approval. Never stop/restart
  Docker containers, databases or dev services without checking they are unused, and ask first if it could interrupt work.

## Git workflow

- One branch per phase/slice (`feat/<phase>-<topic>`, `fix/<topic>`) from up-to-date `main`;
  when verified, merge `--no-ff` into `main`, push, check CI. Commit only when asked or at phase end.
- No global git identity: `git -c user.name=vietnl1 -c user.email=vietnguyen200311@gmail.com commit …`;
  `gh` is not installed – CI status via the public GitHub API (logs need sign-in).

## Commands (root, `pnpm -s …`)

- `infra:up` / `infra:down` (Docker: Postgres :15432, Redis :16379, S3 :18333), `db:bootstrap`,
  `db:migrate`, `storage:bootstrap`. Dev: `pnpm --filter @insightai/api dev` (+ `dev:worker`),
  `pnpm --filter @insightai/web dev` (:5173 → API :3100).
- Checks: `format:check`, `lint`, `typecheck`, `test` (unit), `test:int` (needs infra; uses
  `QUEUE_PREFIX=insightai-test`), `build`. Perf test only with `PERF_TEST=true`.
- Targeted: `cd apps/api && npx vitest run --project unit <file>` / `--project integration <file>`;
  `cd apps/web && npx vitest run <file>`. After editing contracts: `pnpm --filter @insightai/contracts build`.

## Documentation rules

- Update `docs/STATUS.md` (≤ 30 lines) after every task/slice. Decision → `DECISIONS.md` (next D-xx);
  API → `API_DOCUMENTATION.md`; schema → `DATABASE_DESIGN.md`; phase done → `DEVELOPMENT_PLAN.md` ✅ + README.

## Context & token saving

- Never scan the whole repo for a one-module task; use targeted grep/line ranges. Read document
  sections, not whole documents; do not reread unchanged files.
- Do not restate the architecture in tasks; keep progress updates to one line when needed.
- During development run only checks for the changed package/file; full verification once before merge.
- Do not rerun tests without a technical reason; do not chase unrelated warnings unless blocking;
  ask only when an ambiguity materially changes the implementation.

## Final report (Vietnamese, concise; never claim unrun checks passed)

`### Completed` main changes/impact · `### Verification` checks actually run + results ·
`### Remaining Issues` blockers/unverified items, or "None".
