# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 6C merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D analytical engines (D-49–D-51).
- 6C: investigation core – Plan IR + validator, planner (metadata only), worker orchestrator with
  persisted state, approval/cancel/resume, budgets, pinned versions, SSE with replay (D-52, API §5j).

## Verification of 6C

- Unit `plan-validator.test.ts` 32. Integration `investigations.int.test.ts` 11 with a scripted
  planner and the real worker: full run, plan repair, invalid/impossible plans, approval, cancel,
  crash/resume, time budget, MODEL_CHANGED, lost access, privacy, per-user limit.
- Not verified: a real OpenAI planner (no API key); PO decisions taken as defaults (D-52).

## Known issues

- Open risks in `docs/PHASE6_AUDIT.md` §2; managed PG `CREATEROLE` unverified; API image ~0.9 GB.
- No investigation UI yet (6F); `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

6E evidence & hypothesis validation (then 6F reports + UI), when the user asks.
