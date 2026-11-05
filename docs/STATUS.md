# Project status

Updated: 2026-11-05 · Branch: `main` (Phase 6B merged; see git log for the commit).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 design: `docs/PHASE6_AUDIT.md` (risks), `docs/PHASE6_AI_ANALYST_DESIGN.md` (approved roadmap 6A–6H).
- 6A (backend): dashboards/widgets, PRIVATE/ORG by RLS, viewer-scoped runs, pinning (D-49).
- 6B: Dockerfiles (api/worker, migrate, web=Caddy, backup), `docker/compose.prod.yml`, Redis auth,
  backup/restore with global roles, SSE heartbeat + deadline, org `aiDataSharing` (default
  METADATA_ONLY), free-text number/link guard, quota in one transaction (D-50).

## Verification of 6B

- Integration: `ai.int.test.ts` 16 (metadata-only, guard, heartbeat/timeout, concurrent quota).
- Production compose locally: `docker/smoke.mjs` passed; SSE through Caddy 160 s, 10 heartbeats;
  backup → restore into empty PostgreSQL → migrate → API read tenant rows (docs/OPERATIONS.md §4).
- Not verified: a real OpenAI model; managed PostgreSQL `CREATEROLE` support of the chosen provider.

## Known issues

- Open risks in `docs/PHASE6_AUDIT.md` §2 (R-06, R-08, R-09, R-11 partly, R-12–R-16).
- API image ~0.9 GB; numbers written as words are not blocked by the guard.
- `.idea/` is untracked and not in `.gitignore`.

## Next recommended task

6A UI (dashboards + pin from Ask), then 6D analytical engines, when the user asks.
