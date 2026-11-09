# Project status

Updated: 2026-11-09 · Branch: `main` (Phase 6H-1 merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D engines, 6C investigation core, 6E evidence,
  6F reports + investigation UI, 6G eval (oracle) (D-49–D-55). AI workflow: `docs/ai-workflow/`.
- 6H-1: Playwright E2E of the whole journey (`e2e/journey.spec.ts`): sign-up → upload → quality →
  semantic model + metric (UI) → ask + pin → investigation (SSE) → report → evidence → pin finding
  → share → invited viewer reads the dashboard; fake OpenAI (`e2e/fake-openai.mjs`); CI job `e2e`;
  `pnpm test:e2e` (D-56).

## Verification of 6H-1

- E2E locally: 3 consecutive passes (`--repeat-each 3`, 18–23 s each).
- CI `e2e` job: see the merge commit run.

## Known issues

- Anomaly detection (median/MAD, |z| ≥ 3.5) can flag noise on ~30-point series (one eval case).
- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.
- Real-model eval still needs an `OPENAI_API_KEY`.

## Next recommended task

6H-2: k6 load test per `docs/PHASE6_AUDIT.md` §6 and `docs/PILOT.md` (pilot checklist, go-live).
