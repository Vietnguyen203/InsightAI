# Project status

Updated: 2026-11-07 · Branch: `main` (Phase 6F merged; weak-fit trends reported as unclear).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D engines, 6C investigation core, 6E evidence (D-49–D-53).
- AI workflow: Spec Kit 1.2.3 + Karpathy guidelines, constitution, guardrails (`docs/ai-workflow/`).
- 6F-1: REPORTING phase, `investigation_reports`, `GET /investigations/:id/report` (segments tied
  to evidence, guarded LLM wording, templates otherwise), pin with `fromEvidenceId` (D-54).
- 6F-2: web `features/investigations` – list/create, live progress over SSE (polling fallback),
  plan approval/cancel/delete, report with charts from frozen results, evidence drill-down from
  any figure, pin a finding, print/PDF via browser CSS; nav item; vi + en.

## Verification of 6F

- Unit api `report/report.test.ts` 61; web `investigations.test.tsx` 12 (list, create, AI off,
  SSE → report, approval, report sections, evidence drill-down, pin, print, failure, 409, SSE ids).
- Integration `investigations.int.test.ts` 16. Browser: QA org run (scripted LLM, real engine),
  report + drill-down figures match the evidence rows, print CSS present, no overflow at 375 px.
- Not verified: a real OpenAI planner/report writer; actual printed PDF output.

## Known issues

- Investigations finished before 6F have no report (409). `.idea/` untracked, not in `.gitignore`.

## Next recommended task

6G AI evaluation (needs an OpenAI key), then 6H E2E & pilot.
