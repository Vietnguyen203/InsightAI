# Project status

Updated: 2026-11-10 · Branch: `main` (pilot gate E6 merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 (6A–6H, D-49–D-57): dashboards, production readiness, engines, investigations, reports,
  oracle eval, Playwright E2E, k6 on 2M rows (`docs/PERFORMANCE.md`), pilot plan (`docs/PILOT.md`).
- Pilot gate E6 (D-58): operations monitor in the worker – API readiness, 5xx/5 min, queue backlog,
  disk, LLM cost/day → FIRING/RESOLVED to a webhook + log, heartbeat ping; `GET /health/ops`
  (bearer `OPS_STATUS_TOKEN`); `node dist/ops-alert-test.js`; runbook in `docs/OPERATIONS.md` §6.

## Verification of E6

- Unit: alert rules + filter (10 tests). Integration `test/ops-monitor.int.test.ts` (3) + health (7).
- Test alert CLI against a local webhook: delivered. Compose config valid.

## Known issues

- Anomaly detection (median/MAD, |z| ≥ 3.5) can flag noise on ~30-point series (one eval case).
- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.
- Real-model eval still needs an `OPENAI_API_KEY`.

## Next recommended task

Pilot gate E5: restore drill on an empty PostgreSQL (`docs/OPERATIONS.md` §4), measured RTO.
Then deploy (E4) once hosting is chosen; E3 needs `OPENAI_API_KEY`; E8 is contractual.
