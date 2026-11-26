# [S] Merged-quests page from Kixel Quest's records

## Goal

The merged-quests page (`cloudflare/src/bench/`) reads each merged quest
PR's size, writer, reviews, and timings from Kixel Quest's records instead
of parsing PR bodies, wherever [the epic](/quest/m2/mobile/README.md)
settles that the site lives.

## Plan

- The page today parses each merged PR's `## Models` and `## Review`
  sections with the CLI's own readers (`src/cli/models-record.ts` and
  `parseReview` in `src/core/review.ts`) and reads the head commit's check
  runs for CI wall time.
- Upstream is taking that data out of PR bodies: its telemetry epic turns
  `## Review` and `Implementer:` lines into posts to Kixel Quest, and its
  benchmark epic's report is kixel.quest's factory page. Once that lands,
  the page has nothing to parse, so read the same rows from Kixel Quest's
  records and delete the PR-body parsing in `cloudflare/src/bench/load.ts`,
  keeping token cost off public repositories' pages.
- Show no eval scores: upstream deleted `quest eval` on 2026-11-23.
- If the site moves into kixel-ai/kixel.quest, this page is its factory
  page's phone view, and this quest is planned there instead.

## Waiting

- Maintainer: where the site lives, in [the epic](/quest/m2/mobile/README.md)'s
  Waiting.

## Required

- [Sync with upstream](/quest/m2/mobile/sync-upstream.md) - the CLI readers
  and record shapes this page uses must be upstream's current ones
