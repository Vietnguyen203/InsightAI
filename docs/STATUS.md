# Project status

Updated: 2026-11-04 · Branch: `main` (Phase 5a merged; see git log for the commit).

## Completed

- Phase 0–2: docs, foundation, auth/tenancy/RBAC, datasets, import, profiling, dataset UI.
- Phase 3: quality rules/checks (3a), cleaning + versions (3b), quality/cleaning/versions UI (3c).
- Phase 4a: semantic models, validation, publish snapshot (D-40, D-41; API §5e).
- Phase 4b: query engine – fan-out-safe planner, SQL validator, policies, cache (D-42–D-44, API §5f).
- Phase 4c: metrics + versions, compareTo, synonyms, catalog (D-45, D-46, API §5g).
- Phase 4d: web `features/semantic/` – models, metrics, test query + SQL, KPI cards, access.
- Phase 5a: `modules/ai` – LLM tool loop, placeholder narrative + number guard, chart rule,
  conversations, SSE `/ai/ask`, quota, `llm_usage` (D-47, API §5h).

## Verification of 5a

- Unit `answer-text.test.ts` (9); integration `ai.int.test.ts` (13) with a scripted LLM.
- Not verified: a real OpenAI call (no API key on this machine).

## Known issues

- Unverified (earlier sessions, not rechecked): `pg` deprecation warning in integration tests.
- D-06: closed at application level by the SQL validator (D-43); per-tenant login roles stay on the roadmap.
- Re-validation when a dataset changes its active version is not automatic yet; the engine rejects queries on missing columns (DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Phase 5b (Ask page UI + eval set ≥ 50 questions) when the user asks.
