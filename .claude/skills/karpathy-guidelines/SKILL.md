---
name: karpathy-guidelines
description: Behavioural guidelines against common LLM coding mistakes (hidden assumptions, overengineering, drive-by edits, unverified results). Use when writing, reviewing or refactoring code in InsightAI.
license: MIT
---

# Karpathy guidelines (adapted for InsightAI)

Adapted from `karpathy-guidelines` in
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
(commit `2c606141`, MIT), derived from Andrej Karpathy's
[observations on LLM coding](https://x.com/karpathy/status/2015883857489522876).

`CLAUDE.md`, the D-xx decisions and `docs/ai-workflow/ARCHITECTURE-GUARDRAILS.md` take precedence
over this skill. It favours caution over speed; for trivial tasks use judgment.

## 1. Think before coding

- State assumptions explicitly. If several interpretations exist, name them instead of picking
  one silently.
- Ask only when the ambiguity materially changes the implementation; otherwise choose the option
  that matches the surrounding code and say so.
- If a simpler approach exists, say so. If something is unclear or contradicts a decision, stop
  and name it.

## 2. Simplicity first

- The minimum code that solves the task: no speculative features, options or abstractions, no
  error handling for impossible cases.
- If 200 lines could be 50, rewrite it. Would a senior engineer call it overcomplicated? Then
  simplify.

## 3. Surgical changes

- Touch only what the task needs; every changed line traces to the request. Match the existing
  style even where you would do it differently.
- Remove imports/variables your change made unused; mention pre-existing dead code instead of
  deleting it.
- Never "simplify" by weakening RLS, tenant isolation, validation or tests.

## 4. Goal-driven execution

- Turn the task into verifiable goals: "fix the bug" → a test that reproduces it, then passes;
  "add validation" → tests for the invalid inputs.
- For multi-step work, write a short plan of `step → verify: check` and loop until each check
  passes.
- "Verify" means the commands in `CLAUDE.md` (targeted unit/integration tests, `typecheck`,
  `lint`); report what was actually run.
