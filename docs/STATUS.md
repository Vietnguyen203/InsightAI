# Project status

Updated: 2026-11-06 · Branch: `main` (Phase 6E merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards, 6B production readiness, 6D analytical engines, 6C investigation core (D-49–D-52).
- 6E: evidence frozen per step (versions, policies, results, named values), VALIDATING phase,
  deterministic hypothesis rules, ranked findings tied to evidence (D-53, API §5j).

## Verification of 6E

- Unit `validation.test.ts` 34 (every rule × outcome, findings, values); investigation unit total 126.
- Integration `investigations.int.test.ts` 12: hypotheses/findings after a run, evidence endpoint,
  no remapping after a new metric version, RLS + append-only in SQL, crash/resume without
  duplicate evidence, partial runs still validated.
- Not verified: a real OpenAI planner; PO decisions taken as defaults (D-52).

## Known issues

- Open risks in `docs/PHASE6_AUDIT.md` §2; managed PG `CREATEROLE` unverified; API image ~0.9 GB.
- No investigation UI/report yet (6F); `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

6F narrative & reports (report generator + investigation UI), when the user asks.
