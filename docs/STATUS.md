# Project status

Updated: 2026-11-10 · Branch: `main` (pilot gate E5 merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 (6A–6H, D-49–D-57): dashboards, production readiness, engines, investigations, reports,
  oracle eval, Playwright E2E, k6 on 2M rows (`docs/PERFORMANCE.md`), pilot plan (`docs/PILOT.md`).
- Pilot gate E6 (D-58): operations monitor in the worker, alerts via webhook, `GET /health/ops`.
- Pilot gate E5: restore drill on the dev machine (`docs/OPERATIONS.md` §4): backup → empty
  PostgreSQL 16 → bootstrap/migrate → API; login, 10 widgets + totals identical to the source,
  all tenant row counts equal; RTO 72 s. Docs only, no code change.

## Verification of E5

- Commands run as recorded in OPERATIONS §4; temporary container, backup archive and secrets
  removed afterwards. Dev containers untouched.

## Known issues

- Anomaly detection (median/MAD, |z| ≥ 3.5) can flag noise on ~30-point series (one eval case).
- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.
- Real-model eval still needs an `OPENAI_API_KEY`.

## Next recommended task

Remaining pilot gates need you: E3 real-model eval (`OPENAI_API_KEY`), E4 choose hosting and deploy
(then rerun k6, restore drill and alert test there), E8 data agreements with pilot organizations.
