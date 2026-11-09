# Project status

Updated: 2026-11-09 · Branch: `main` (Phase 6H-2 merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D engines, 6C investigation core, 6E evidence,
  6F reports + investigation UI, 6G eval (oracle) (D-49–D-55). AI workflow: `docs/ai-workflow/`.
- 6H-1: Playwright E2E of the whole journey, fake OpenAI, CI job `e2e`, `pnpm test:e2e` (D-56).
- 6H-2: k6 load test on 2,000,000 rows (`k6/seed.mjs`, `k6/load.mjs`; manual, not in CI; D-57),
  results in `docs/PERFORMANCE.md`; pilot plan (entry gate, feedback form, go-live) in `docs/PILOT.md`.

## Verification of 6H-2

- k6 20 VU / 3 min: cache-miss p95 494 ms, cache-hit p95 210 ms, dashboard p95 595 ms, 0 % errors.
- Cold dashboard (`COLD=1`, 4 users at once, no widget cached): max 2.21 s. All thresholds met (dev machine).

## Known issues

- Anomaly detection (median/MAD, |z| ≥ 3.5) can flag noise on ~30-point series (one eval case).
- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.
- Real-model eval still needs an `OPENAI_API_KEY`.

## Next recommended task

Phase 6 is complete in code. Before the pilot: entry gate in `docs/PILOT.md` §1 (real-model eval needs
`OPENAI_API_KEY`, choose hosting, deploy + rerun k6 there, restore drill, monitoring/alerts, data agreements).
