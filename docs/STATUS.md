# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 6A UI merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md` (risks), `docs/PHASE6_AI_ANALYST_DESIGN.md` (approved roadmap 6A–6H).
- 6A: dashboards backend (D-49) + web `features/dashboards/` – list/create, 12-column grid, layout
  editing by buttons, version-changed / needs-update states, pin from Ask answers and KPI cards.
- 6B: production images + compose, Redis auth, backup/restore with roles, SSE heartbeat/deadline,
  org `aiDataSharing` (default METADATA_ONLY), free-text guard, quota transaction (D-50).

## Verification of 6A UI

- Component tests `dashboards.test.tsx` (9); full web suite 56.
- Browser (local QA account): pin AI answer to a new dashboard, open it, widen widget (layout saved),
  375px without horizontal overflow.

## Known issues

- Open risks in `docs/PHASE6_AUDIT.md` §2 (R-06, R-08, R-09, R-11 partly, R-12–R-16).
- Not verified: a real OpenAI model; managed PostgreSQL `CREATEROLE` support of the chosen provider.
- API image ~0.9 GB; `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

6D analytical engines (deterministic, no LLM) per the design doc, when the user asks.
