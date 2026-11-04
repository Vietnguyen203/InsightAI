# Project status

Updated: 2026-11-04 · Branch: `feat/phase-4a-semantic-model` · `main` = Phase 3 complete, CI green.

## Completed

- Phase 0–2: docs, foundation, auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3: quality rules/checks (3a), cleaning + versions (3b), quality/cleaning/versions UI (3c).
- Phase 4a (this branch): semantic models – entities, dimensions, measures, relationships, draft
  editing, validation (static + data checks), publish as immutable snapshot (D-40, D-41).
  API in `docs/API_DOCUMENTATION.md` §5e; module `apps/api/src/modules/semantic/`.

## Verification of 4a

- format:check, lint, typecheck, build pass; unit 4 + 90 + 32, integration 89 passed (1 perf skipped).
- New: `semantic-validation.test.ts` (8 unit), `semantic.int.test.ts` (7 integration).

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- D-06 – tenant SQL could still `SET ROLE`; the SQL validator of 4b must block it.
- Re-validation when a dataset changes its active version is not automatic yet (4b/4c).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 4b: query engine (IR → plan → SQL → validator → executor), access policies, result cache.
