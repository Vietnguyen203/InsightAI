# Project status

Updated: 2026-11-07 · Branch: `main` (Phase 6G oracle merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D engines, 6C investigation core, 6E evidence,
  6F reports + investigation UI (D-49–D-54). AI workflow: Spec Kit + Karpathy (`docs/ai-workflow/`).
- 6G (oracle): investigation eval set of 210 cases (groups B–K) on a fixture with planted effects
  (`apps/api/test/eval/`), harness `investigation-eval.int.test.ts` (oracle + real mode, JSON
  report, known-failure gate), both eval sets in CI with `AI_EVAL=oracle` (D-55).
- Fix found by the eval: a snapshot over a period without data is now `NO_DATA` (not verified).

## Verification of 6G

- Oracle: A 60/60; B–K 209/210 – the one miss is a known detector false positive
  (I-september-anomaly), see `docs/EVAL_REPORT.md`. Unit investigation tests 190.
- Not executed: real-model eval (no `OPENAI_API_KEY`).

## Known issues

- Anomaly detection (median/MAD, |z| ≥ 3.5) can flag noise on ~30-point series (one case).
- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.

## Next recommended task

Real-model eval when an OpenAI key is available; 6H E2E & pilot.
