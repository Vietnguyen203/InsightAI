# Project status

Updated: 2026-11-04 · Branch: `feat/phase-4d-semantic-ui` · `main` = Phase 4c merged, CI green.

## Completed

- Phase 0–2: docs, foundation, auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3: quality rules/checks (3a), cleaning + versions (3b), quality/cleaning/versions UI (3c).
- Phase 4a: semantic models, validation, publish snapshot (D-40, D-41; API §5e).
- Phase 4b: query engine – fan-out-safe planner, SQL validator, policies, cache (D-42–D-44, API §5f).
- Phase 4c: metrics + versions, compareTo, synonyms, catalog (D-45, D-46, API §5g).
- Phase 4d (this branch): web `features/semantic/` – models, metrics, test query + SQL, KPI cards, access.

## Verification of 4d

- Browser (local QA account): model → entity/members → validate (errors shown) → publish → metrics
  (incl. ratio) → synonym → test query + SQL → KPI cards → policy; 375px without overflow.
- Component tests `semantic.test.tsx` (6); full checks: see the 4d final report.

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- D-06: closed at application level by the SQL validator (D-43); per-tenant login roles stay on the roadmap.
- Re-validation when a dataset changes its active version is not automatic yet; the engine rejects queries on missing columns (DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 5 (AI analytics) when the user asks.
