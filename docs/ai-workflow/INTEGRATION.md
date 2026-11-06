# Spec Kit + Karpathy guidelines – integration notes

Developer tooling only: nothing here is a runtime dependency of InsightAI (no change to
`package.json`, lockfile, source code, database or CI). Workflow: `DEVELOPMENT.md`.

## Installed tools (developer machine)

| Tool | Version | How | Notes |
|---|---|---|---|
| uv | 0.13.5 | `python -m pip install --user uv` | Not on PATH; call as `python -m uv`. |
| specify-cli (GitHub Spec Kit) | 1.2.3 (tag `v1.2.3`, commit `5ea8b1cf`) | `python -m uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.2.3` | Executable `C:\Users\Admin\.local\bin\specify.exe` (on PATH). |
| Karpathy guidelines | upstream commit `2c606141` (2026-04-20), MIT | Adapted by hand into `.claude/skills/karpathy-guidelines/SKILL.md` | Source: `github.com/multica-ai/andrej-karpathy-skills`. Not installed as a plugin. |

Version rule: only releases at least two weeks old are installed (1.2.6 and 1.3.x were too new on
2026-11-06).

## Project initialisation

```
specify init --here --integration claude --script py \
  --integration-options="--events false --no-model-invocation"
```

- `--events false`: no `.claude/settings.json` hooks are written.
- `--no-model-invocation`: every `speckit-*` skill has `disable-model-invocation: true`, so only
  the user can start them.

## Files

Created by `specify init` (36 files, nothing modified or removed):

- `.claude/skills/speckit-{analyze,checklist,clarify,constitution,converge,implement,plan,specify,tasks,taskstoissues}/SKILL.md`
- `.specify/` – `init-options.json`, `integration.json`, `integrations/*.manifest.json`,
  `memory/constitution.md` (then replaced, see below), `scripts/python/*.py`,
  `scripts/powershell/*.ps1`, `templates/*-template.md`, `workflows/` (bundled "Full SDD Cycle"
  workflow, unused), `.gitignore`.

Written for InsightAI:

- `.specify/memory/constitution.md` – invariants, pointing to the source documents.
- `.claude/skills/karpathy-guidelines/SKILL.md` – adapted guidelines.
- `docs/ai-workflow/{DEVELOPMENT,ARCHITECTURE-GUARDRAILS,INTEGRATION}.md`.
- `CLAUDE.md` – one reference line at the end of "Start here"; the other 80 lines unchanged.
- `.prettierignore` – `.specify` and `.claude/skills/speckit-*`: generated files fail
  `format:check`, and reformatting them would break Spec Kit's manifest hashes.

`specs/` is not created yet; it appears with the first `/speckit-specify`.

## Use

**Claude Code (verified):** type `/speckit-specify …`, `/speckit-plan`, … in a session opened at
the repository root. The Karpathy skill is model-invocable and loads when relevant; it can also be
called as `/karpathy-guidelines`.

**Cowork (not verified):** whether Cowork reads repository `.claude/skills/` was not tested. Manual
fallback: open the matching `SKILL.md`, paste it with the task, and add to the project
instructions:

> Follow `CLAUDE.md`, `.specify/memory/constitution.md` and
> `docs/ai-workflow/ARCHITECTURE-GUARDRAILS.md`. Use `docs/ai-workflow/DEVELOPMENT.md` to size the
> task; large tasks go through spec → plan → tasks with my approval after plan and tasks.

## Upgrade

1. Pick a release at least two weeks old; read its changelog (re-evaluate 1.2.6 on 2026-11-16).
2. `python -m uv tool install --force specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z`
3. `specify integration upgrade claude --integration-options="--events false --no-model-invocation"`
4. Check `git diff`: the constitution and these docs must be unchanged; every `speckit-*` skill
   still has `disable-model-invocation: true`; no `.claude/settings.json` appeared.

## Known limitations

- 1.2.3 records stale manifest hashes after `init --force` (fixed upstream in 1.2.6, #5193); do not
  run `init --force`, `upgrade` or `uninstall --force` on 1.2.3.
- `speckit-taskstoissues` is deprecated upstream and needs `gh`, which is not installed.
- Spec Kit's default branch naming is replaced by the `CLAUDE.md` convention (`DEVELOPMENT.md`).
- Until committed, these files are untracked and follow the working tree across branch switches.

## Rollback

Remove the added paths (after checking nothing else was added there): `.specify/`,
`.claude/skills/speckit-*/`, `.claude/skills/karpathy-guidelines/`, `docs/ai-workflow/`, the
one "AI workflow" line in `CLAUDE.md` and the two Spec Kit lines in `.prettierignore`. Then `python -m uv tool uninstall specify-cli` (and
optionally `python -m pip uninstall uv`). No application code, data or dependency is affected.
