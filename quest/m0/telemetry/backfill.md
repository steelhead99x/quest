# [S] Send every session still on a host

## Goal

`quest records backfill --since <date>` sends every session still on the host since that date, as the sender would have when it ended, its transcript for a person who opted in, and the last round of every review session saved under a clone's `.git/quest/review/`, as `quest review` would have posted it with its score and rationale. Earlier saved rounds keep only their head, merge base, and findings, so a backfill skips them rather than post a round without its score. Resending is harmless: Kixel Quest stores a session once.

## Plan

Decided in [kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104): ✅ backfill everything still on disk (rejected: since 2026-11-07; since 2026-11-14). Claude Code was deleting transcripts older than 30 days until kixel-ai/dotfiles#248 kept them ten years; run it on every host soon after it ships.

- Reuse the sender's path, so a backfilled record is indistinguishable from a live one except for when it was sent.

Tests: on a seeded host, a backfill since a date sends each session and each saved review session's last round once, and a second run sends nothing new.

## Required

- [Sessions](/quest/m0/telemetry/sessions.md) - the record fields a backfilled session fills
- [Transcripts](/quest/m0/telemetry/transcripts.md) - the upload a backfill repeats
- [Review posts](/quest/m0/telemetry/review-posts.md) - the post a saved round is sent as
