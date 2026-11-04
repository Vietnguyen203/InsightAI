# Project status

Updated: 2026-11-04 · Branch: `main` = 45650d3 (Phase 4b merged, CI green).

## Completed

- Phase 0–2: docs, foundation, auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3: quality rules/checks (3a), cleaning + versions (3b), quality/cleaning/versions UI (3c).
- Phase 4a: semantic models – entities, dimensions, measures, relationships, draft
  editing, validation (static + data checks), publish as immutable snapshot (D-40, D-41).
  API in `docs/API_DOCUMENTATION.md` §5e; module `apps/api/src/modules/semantic/`.
- Phase 4b: query engine `apps/api/src/modules/query-engine/` – fan-out-safe planner,
  libpg-query SQL validator, access policies, Redis cache, query_history (D-42–D-44, API §5f).

## Verification of 4b

- Unit `query-engine.test.ts` (10), integration `query-engine.int.test.ts` (7, double-counting fixture).

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- D-06: closed at application level by the SQL validator (D-43); per-tenant login roles stay on the roadmap.
- Re-validation when a dataset changes its active version is not automatic yet; the engine rejects queries on missing columns (DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 4c: metrics + versions (simple/ratio/derived), synonyms, catalog/KPI API, compareTo.
