# Project status

Updated: 2026-11-04 · Branch: `main` = b06ecad (Phase 4c merged, CI green).

## Completed

- Phase 0–2: docs, foundation, auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3: quality rules/checks (3a), cleaning + versions (3b), quality/cleaning/versions UI (3c).
- Phase 4a: semantic models, validation, publish snapshot (D-40, D-41; API §5e).
- Phase 4b: query engine `apps/api/src/modules/query-engine/` – fan-out-safe planner,
  libpg-query SQL validator, access policies, Redis cache, query_history (D-42–D-44, API §5f).

- Phase 4c: metrics with immutable versions (simple/ratio/derived), compareTo,
  synonyms, catalog (D-45, D-46, API §5g); module `semantic-metric.*`, planner in `query-engine/`.

## Verification of 4c

- Unit `query-engine.test.ts` (15), integration `metrics.int.test.ts` (6) pass.

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- D-06: closed at application level by the SQL validator (D-43); per-tenant login roles stay on the roadmap.
- Re-validation when a dataset changes its active version is not automatic yet; the engine rejects queries on missing columns (DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 4d: semantic UI – model editor, metric editor with test query, KPI cards (frontend).
