# Agent instructions audit

The goal is instructions agents load that are short, agree with each other, follow the current official guidance of every harness and model the repository's agents run, and change what agents do.
The scope is every file an agent loads as context from the repository: `AGENTS.md` and `CLAUDE.md` at every depth, `CONTRIBUTING.md`, `REVIEW.md`, skills with their descriptions, path-scoped rules, the context hooks inject, and the prompts and instructions its code plants or sends to agents.
Machine-level files, such as `~/.claude/CLAUDE.md`, belong to the repository that holds them, and files another repository ships or syncs, such as `quest`'s rules and skill stubs, are fixed at their source: plan a follow-up there instead of editing the copy.
Turning new mistakes into new rules is not this audit's work, and which models run is not either.

Gather first, over the window since the date the last run's baseline records, or the past month on the first run:

- Harnesses and models: the ones the repository's agents ran, writers and reviewers alike, from its PRs' `## Models` lines and `## Review` records.
- Guidance: every page `quest guide prompting` links, checked to resolve, then read, along with the current pages for each harness and model found above that it lacks.
- Evidence: review findings and `## Caused by` escapes from `quest usage --since`, or from the PRs' own `## Review` and `## Caused by` sections where it cannot read the repository's forge, with each finding's text, which the counts lack, from its review thread, from the transcript of the reviewer session its PR's `## Review` record names, or from the review record `quest review` keeps for the branch under `quest/review/` in the checkout's common Git directory; corrections people typed, from `quest messages --since`, never with `--all`, run in a checkout of the repository on each host that runs its agents, which prints that repository's entries only; and the transcripts of sessions whose working directory was one of its checkouts. Read no other repository's messages or transcripts, and quote none in the PR or the stub: give counts and paraphrase.

Look for:

- Load budgets: each harness's loaded set, joined as it joins them from the root to the deepest working directory agents use, measured against the limits its pages give, such as Codex's `project_doc_max_bytes` and skill-list budget, and Claude Code's per-file size target and skill-description cap. Text past a limit is cut silently.
- Files a harness never loads, as `quest guide prompting` describes.
- Anything the files do against `quest guide prompting`'s rules, such as contradictions and repeats.
- Commands, flags, paths, and links in instruction files that no longer work.
- Rules the evidence shows agents ignore, misread, or never need, and mistakes recurring under a rule meant to stop them.
- Guidance the pages give that the files miss or contradict.
- Risk tiers: whether `RISK.md` rates a change to these files at least medium; propose that line where one could land as low or through an `## Automatic` class.

Where several harnesses' loaded sets or a large body of evidence are in scope, split the reading across parallel sub-agents, one per set and one for the evidence, each returning findings with a path and line, or a count of sessions.

Cut, consolidate, and rewrite in the run's PR, as `quest guide prompting` describes.
Add a rule only where cutting or merging others cannot fix a finding; that replaces the running steps' `AGENTS.md` proposal for this audit.
List each edit under the PR's `## Waiting` as its own `Maintainer:` decision, with keep and revert as its choices and your recommendation marked, so the maintainer drops one without rejecting the rest; the PR lands only on those answers, and the reverts they ask for make a new head that gets a new review.
Landing on those answers is the user's agreement `quest context` asks for before a rule changes, so the run makes these edits without asking first.
Record as the next stub's baseline the date and commit this run read through, the hosts whose messages it read with how many unnamed directories `quest messages` dropped entries of on each, each harness's loaded size as measured, the date each guidance page was read, and each rule kept against the evidence with why, so the next run reads what changed since.
