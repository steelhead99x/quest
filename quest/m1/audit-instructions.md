# [XL] Audit agent instructions

## Goal

Run the `instructions` audit: `quest audit instructions` prints what it checks, what each finding becomes, and how to plan its next run.

## Plan

- The instructions under `assets/` reach every repository's agents, about 2k sessions a week, so they matter most here.
- Beyond the files agents load here, the scope includes what this repository ships to others' agents: everything under `assets/`, `SETUP.md`, `docs/context.md`, `src/cli/rules.ts`, and the instructions code plants or injects that `RISK.md`'s bullet on what `quest` plants or injects names, such as hook context, skill stubs, and the reviewer's and classifier's prompts.
- This audit is the ask `AGENTS.md` wants before editing `CONTRIBUTING.md`, `assets/CONTEXT.md`, `assets/AGENTS.md`, or `assets/skills/`.
- `assets/CONTEXT.md` stays within the 10,000 characters Claude Code shows of a hook's context.
- The model tables in `src/cli/models.ts` belong to the [model check](/quest/m1/model-check.md).
- Evidence from a kixel-ai/kio `/quest-run` session on 2026-11-26, for this audit to weigh:
  - The guide's Prompting rule wants a skill's description to open with when it should and should not run. Of the eight installed skills in `assets/skills/` (`grill` is internal), six don't say when to run; only `quest-afk` and `quest-plan` have a "Use when" clause, and none says when not to run. `quest-import`, `quest-start`, and `quest-merge` are the thinnest.
  - Five sub-agents re-ran `quest context` after SubagentStart had injected it (`src/cli/hooks.ts`, `claimSessionPacks` in `src/cli/context.ts`). Likely causes: `assets/CONTEXT.md`'s "run `quest context <pack...>` directly for any pack", and briefs or `AGENTS.md` files saying "run `quest context` before any work" without the planted line's "unless this session already holds its rules". The audit picks the fix.

## Audit

- instructions

## Required

- [m0](/quest/m0/README.md) - the audit runs after it
