# Project status

Updated: 2026-11-10 · Branch: `main` (E3 fixes + E4 deploy kit merged; see git log).

## Completed

- Phase 0–5: foundation, data/quality/cleaning, semantic layer + query engine + metrics, AI Q&A + Ask UI.
- Phase 6 (6A–6H, D-49–D-57): dashboards, production readiness, engines, investigations, reports,
  oracle eval, Playwright E2E, k6 on 2M rows (`docs/PERFORMANCE.md`), pilot plan (`docs/PILOT.md`).
- Pilot gates: E5 restore drill (RTO 72 s), E6 monitoring + alerts (D-58).
- E3 (D-59, partial): real-model eval on Groq `openai/gpt-oss-120b`; pacing/sampling helpers; two
  answer defects found and fixed (granularity rule, repeated unit). Sample 17/19 after the fix.
- E4 (D-60): Oracle Cloud Always Free single-VM deployment – `docker/oracle/setup.sh`, `ops.sh`,
  compose profile `selfhosted-s3`, guide `docs/DEPLOY_ORACLE.md`; images verified on arm64.

## Verification

- E4 local rehearsal (script's env generation): smoke passed incl. SeaweedFS upload/import, backup
  OK; arm64 images build, native modules run. API unit 313/313; oracle evals; lint/types/format clean.

## Known issues

- Groq free tier 200k tokens/day: full Q&A eval + investigation sample wait for the quota to refill.
- Anomaly detection can flag noise on ~30-point series (one eval case). `.idea/` untracked.

## Next recommended task

Rerun the full Q&A eval and a ~30-case investigation sample when the quota refills, then write
`docs/EVAL_REPORT.md` (E3). E4: create the Oracle VM + DuckDNS name (`docs/DEPLOY_ORACLE.md` §1–2),
run `setup.sh`, then the §5 checks.
