# AI-assisted development workflow

How Claude works on InsightAI. Project rules live in `CLAUDE.md`; this file only adds task sizing
and how Spec Kit and the Karpathy guidelines fit in. Invariants:
`.specify/memory/constitution.md`. Protected areas: `ARCHITECTURE-GUARDRAILS.md`. Tooling and
setup: `INTEGRATION.md`.

## Instruction hierarchy

When sources disagree, the higher one wins; a real conflict is raised to the user, never resolved
silently.

1. Platform safety rules.
2. `CLAUDE.md`.
3. Accepted decisions D-xx (`docs/DECISIONS.md`) and the design documents in `docs/`.
4. `ARCHITECTURE-GUARDRAILS.md` and the constitution.
5. Approved Spec Kit artifacts (`spec.md`, `plan.md`, `tasks.md`) of the current feature.
6. Karpathy guidelines (`.claude/skills/karpathy-guidelines/SKILL.md`).
7. The task's own requirements.

## Task sizing

| Size | Typical scope | Workflow |
|---|---|---|
| Small | Typo, copy, one-file fix, test for existing behaviour | Read the module, change it, run the targeted check. No Spec Kit. |
| Medium | A slice inside one module or phase, no new decision | Short plan in chat, implement, targeted checks, update `docs/STATUS.md`. No Spec Kit unless the user asks. |
| Large | A new phase or slice per `docs/DEVELOPMENT_PLAN.md`, a new module, a cross-module change, anything touching `ARCHITECTURE-GUARDRAILS.md` | Spec Kit flow below, with approval gates. |

Unsure between two sizes → take the larger one. Anything in a protected area also needs the
guardrail change protocol, whatever its size.

## Spec Kit flow (large tasks)

The `/speckit-*` skills are user-invoked only (`disable-model-invocation: true`); Claude does not
start them on its own.

1. `/speckit-specify` – what and why, no implementation. One feature per phase/slice.
2. `/speckit-clarify` – resolve open questions (optional when none).
3. `/speckit-plan` – design against the constitution's Quality Gates and the D-xx decisions.
   **Stop: user approves the plan.** New decisions are proposed here, recorded as D-xx after
   approval.
4. `/speckit-tasks` – ordered tasks with the tests that prove them. **Stop: user approves the
   tasks.**
5. `/speckit-analyze` – consistency check of spec, plan and tasks (optional).
6. `/speckit-implement` – implement on the phase branch, following `CLAUDE.md`.

`/speckit-checklist` and `/speckit-converge` are optional. `/speckit-taskstoissues` is deprecated
upstream and not used (no `gh` here). Spec Kit artifacts go under `specs/`, created only when the
first large feature starts.

## Mapping to project conventions

- **Phases**: one Spec Kit feature per `DEVELOPMENT_PLAN.md` phase or slice; never start the next
  phase without the user's go.
- **Branches**: `CLAUDE.md` naming (`feat/<phase>-<topic>`, `fix/<topic>`) wins over Spec Kit's
  numbered branch names; create the branch manually before `/speckit-specify` when needed.
- **Docs**: `STATUS.md`, `DECISIONS.md`, `API_DOCUMENTATION.md`, `DATABASE_DESIGN.md`,
  `DEVELOPMENT_PLAN.md` are updated as `CLAUDE.md` says; Spec Kit artifacts do not replace them.
- **Commits**: only when asked or at phase end, with the identity in `CLAUDE.md`.

## Verification and report

Each check is reported as one of:

- **Passed** – run, succeeded (cite the command and result).
- **Failed** – run, did not succeed (cite the error).
- **Not executed** – not run, with the reason.
- **Blocked** – could not run (missing infra, approval, access).

Checks are the `CLAUDE.md` commands: targeted while developing, the full set
(`format:check`, `lint`, `typecheck`, `test`, `test:int`, `build`) once before merge. The final
report follows `CLAUDE.md` (`### Completed` / `### Verification` / `### Remaining Issues`).
