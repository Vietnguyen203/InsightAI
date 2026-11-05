# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 6D merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md`, `docs/PHASE6_AI_ANALYST_DESIGN.md` (roadmap 6A–6H).
- 6A dashboards (backend + UI, pinning), 6B production readiness (D-49, D-50).
- 6D: `modules/investigation` – exact decimals, comparison, contribution + ratio mix/rate,
  trend, distribution, anomaly; `AnalysisToolsService` runs tools as the user (D-51); catalog
  `additive`/`ratio`.

## Verification of 6D

- Unit `analysis.test.ts` 60 (incl. property tests: parts always add up); line coverage of
  `analysis/*` 99.7 % (`npx vitest run --project unit src/modules/investigation --coverage.enabled
  --coverage.include='src/modules/investigation/analysis/**'`).
- Integration `analysis-tools.int.test.ts` 8: exact totals, ratio, NOT_ADDITIVE, viewer row
  policy, planted anomaly, query_history source, tenant isolation.

## Known issues

- Open risks in `docs/PHASE6_AUDIT.md` §2; no real OpenAI run yet; managed PG `CREATEROLE` unverified.
- API image ~0.9 GB; `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

6C investigation core (Plan IR, validator, orchestrator, SSE) using these tools, when the user asks.
