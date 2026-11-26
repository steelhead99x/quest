# [XL] Audit agent instructions

## Goal

Run the `instructions` audit: `quest audit instructions` prints what it checks, what each finding becomes, and how to plan its next run.

## Plan

- The instructions under `assets/` reach every repository's agents, about 2k sessions a week, so they matter most here.
- Beyond the files agents load here, the scope includes what this repository ships to others' agents: everything under `assets/`, `SETUP.md`, `docs/context.md`, `src/cli/rules.ts`, and the instructions code plants or injects that `RISK.md`'s bullet on what `quest` plants or injects names, such as hook context, skill stubs, and the reviewer's and classifier's prompts.
- This audit is the ask `AGENTS.md` wants before editing `CONTRIBUTING.md`, `assets/CONTEXT.md`, `assets/AGENTS.md`, or `assets/skills/`.
- `assets/CONTEXT.md` stays within the 10,000 characters Claude Code shows of a hook's context.
- The model tables in `src/cli/models.ts` belong to the [model check](/quest/m1/model-check.md).

## Audit

- instructions

## Required

- [m0](/quest/m0/README.md) - the audit runs after it
