# Project status

Updated: 2026-11-04 · Branch: `main` = 5b97da7 (Phase 3c merged, CI green).

## Completed

- Phase 0 docs · Phase 1 foundation · Phase 2 auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3a quality backend · 3b cleaning + versions backend (merged into main).
- Phase 3c quality/cleaning/versions UI (merged): tabs in `apps/web/src/features/quality/`,
  component tests `quality.test.tsx`, README and DEVELOPMENT_PLAN marked ✅.

## Verification of 3c (2026-11-04)

- Browser (local QA account, dataset with known defects): quality report, failing-row samples, rule
  editor with live expression check, suggestions → steps → preview → apply, version compare,
  activate and rollback; desktop 1366px and mobile 375px (no horizontal overflow); no console errors.
- format:check, lint, typecheck, unit (4 + 82 + 32), integration (82 passed, 1 perf skipped), build: pass.

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- Unverified (earlier sessions, not rechecked): D-06 – tenant SQL could still `SET ROLE`; block in Phase 4.
- Sidebar item "Chất lượng dữ liệu" (org-wide page) is still "Sắp có"; quality lives in the dataset page.
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 4 (semantic layer & KPI) on a new branch when the user asks.
