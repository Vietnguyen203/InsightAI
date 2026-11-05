# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 5 complete; see git log for the commit).

## Completed

- Phase 0–3: foundation, auth/tenancy/RBAC, datasets/import/profiling, quality, cleaning, versions + UI.
- Phase 4: semantic models (4a), query engine (4b), metrics/catalog (4c), semantic UI (4d).
- Phase 5a: `modules/ai` – tool loop, placeholder narrative + number guard, conversations,
  SSE `/ai/ask`, quota, `llm_usage` (D-47, API §5h).
- Phase 5b: web `features/ask/` – chat, stages, SVG chart, table, sources, SQL, history;
  eval set `apps/api/test/eval/ai-eval-set.json` + runner `test/ai-eval.int.test.ts` (D-48).

## Verification of 5b

- Component tests `ask.test.tsx` (7); eval runner in oracle mode: 60/60.
- Browser via a local fake OpenAI server (real adapter): ask, follow-up, clarification,
  cannot-answer, sources, SQL; 375px without overflow.
- Not verified: a real OpenAI model and its eval accuracy (no API key on this machine).

## Known issues

- Unverified (earlier sessions): `pg` deprecation warning in integration tests.
- D-06 closed at application level (D-43); per-tenant login roles stay on the roadmap.
- No automatic re-validation when a dataset changes its active version (engine rejects DATA_UNAVAILABLE).
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

Run the eval with an API key; then Phase 6 (dashboards & MVP release) when the user asks.
