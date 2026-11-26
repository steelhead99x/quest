# Quest posts every session's telemetry to Kixel Quest

## Goal

Every `quest-*` skill session's telemetry reaches Kixel Quest through `quest`: session records, the routing decision behind each session, every review round and its findings' outcomes, breakages, and, with the person's permission, transcripts.
Data for metrics and analysis lives in Kixel Quest; GitHub keeps what starting and landing a quest needs, so `## Review` and `Implementer:` lines leave PR bodies.
Kixel Quest's [factory insight epic](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/README.md) stores, charts, and backfills it; this epic is the `quest` side.

Non-goals: storage and views, which Kixel Quest owns; repository- or user-level model settings.

## Plan

Decided 2026-11-22 with the maintainer (`/quest-plan` in [kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104)), reversing the 2026-11-21 plan to move `records`, `eval`, `agent`, `worktree`, `gate`, and model routing out of this repository: ✅ "`quest` is public. … quest is the public binary that contributors and maintainers run that posts metrics to kixel.quest, which is a public website and dashboard. We're focusing on metrics first but the idea is to move spawning/workers/etc to kixel.quest eventually" (rejected: a `kixel-quest` binary). The root [quests README](/quest/README.md) records the rest.

- ✅ Posting needs `quest login`, a free GitHub sign-in at kixel.quest, with no local fallback (rejected: optional; required only on repositories that installed the App).
- ✅ `## Review` and `Implementer:` lines become posts; `## Caused by` stays in the body (rejected: all three; only `## Review`).
- Agent's choice: the wire shapes of every post live here and Kixel Quest imports them from `quest/core`, as it imports Quest's other modules, so sender and server cannot drift. `quest` posts to `https://kixel.quest`; an environment variable overrides it for tests only.
- Each child lands after its Kixel Quest counterpart is deployed, so no release posts what the server would refuse. Each child's `## Waiting` names its counterpart.
- Decided 2026-11-23 (maintainer, `/quest-run` in [kixel-ai/kixel.quest#110](https://github.com/kixel-ai/kixel.quest/pull/110)): ✅ Kixel Quest's server sides ship first (rejected: client first, which would post to a server with no endpoint for the data). Since the Worker imports each post's shape from `quest/core` at a pinned commit, each server-side child there first lands its post's shape and parser in `quest/core` here, in a PR that sends nothing. Each child here then sends that shape rather than defining it.

This epic owns the end-to-end test against a local Worker: a session started with `quest agent`, reviewed with `quest review`, and ended posts its record, routing decision, and rounds, and its PR body gains no `## Review` or `Implementer:` line.
