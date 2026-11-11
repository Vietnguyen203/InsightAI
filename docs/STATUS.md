# Project status
Updated: 2026-11-11 · Branch: `main` (E4 kit + D-62 merged at `b6e08b6`).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 (6A–6H, D-49–D-57): dashboards, production readiness, engines, investigations, reports,
  oracle eval, Playwright E2E, k6 on 2M rows (`docs/PERFORMANCE.md`), pilot plan (`docs/PILOT.md`).
- Pilot gates: E5 restore drill (RTO 72 s), E6 monitoring + alerts (D-58).
- E3 (D-59, partial): real-model eval on Groq `openai/gpt-oss-120b`; pacing/sampling helpers; two
  answer defects found and fixed (granularity rule, repeated unit). Sample 17/19 after the fix.
- E4: Oracle free kit (D-60, alternative) and the chosen setup (D-61): this Windows machine +
  Cloudflare Tunnel – `docker/local/setup.ps1`, `ops.ps1`, profiles `tunnel`/`quick-tunnel`.
- Ask chat (D-62): tool `reply` / status `CHAT`; only numbers already shown; `tool_use_failed` retried.

## Verification

- setup.ps1 rehearsed (-NoTunnel): stack 64 s, smoke OK. Unit 390, int 158, E2E local 4/4, lint clean.

## Known issues

- Groq free tier 8k tokens/min, 200k/day: evals must be paced; never run other int tests meanwhile.
- CI on `b6e08b6`: E2E failed once (passes 4/4 locally); rerun pending. Manual tests: `docs/TEST_SCENARIOS.md`.
- Anomaly detection may flag noise on ~30-point series. Report: `docs/PROJECT_REPORT.md`.

## Next recommended task

E3: run the Q&A eval once a day with `AI_EVAL_RESUME=true` (same report) until complete, then
~30 investigation cases and `docs/EVAL_REPORT.md`. E4: run `setup.ps1` for real (public quick tunnel), then a Named Tunnel
(domain on Cloudflare) and the checks in `docs/DEPLOY_LOCAL_TUNNEL.md` §5.
