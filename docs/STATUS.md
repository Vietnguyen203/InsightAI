# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 6A merged; see git log for the commit).

## Completed

- Phase 0–3: foundation, auth/tenancy/RBAC, datasets/import/profiling, quality, cleaning, versions + UI.
- Phase 4: semantic models (4a), query engine (4b), metrics/catalog (4c), semantic UI (4d).
- Phase 5: AI backend (5a, D-47) and Ask page + eval set (5b, D-48).
- Phase 6 audit: `docs/PHASE6_AUDIT.md` (risk register, dashboard design, task plan 6A–6H).
- Phase 6A: `modules/dashboard` – dashboards/widgets, PRIVATE/ORG by RLS, viewer-scoped widget
  runs, AI answer pinning, layout (D-49, API §5i, migration `20261110090000_dashboards`).

## Verification of 6A

- Integration `dashboards.int.test.ts` (12): visibility, roles, policies per viewer, latest metric
  version, pinning, tenant isolation, RLS checked directly in SQL, audit.
- Not verified: a real OpenAI model and its eval accuracy (no API key on this machine).

## Known issues

- Open risks R-01…R-16 in `docs/PHASE6_AUDIT.md` §2 (P0: backup with roles, production images).
- D-06 closed at application level (D-43); per-tenant login roles stay on the roadmap.
- No automatic re-validation when a dataset changes its active version (DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 6B (dashboard UI + pin from Ask) when the user asks.
