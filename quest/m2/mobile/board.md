# [M] Quest board and stats

## Goal

The [Worker](/quest/m2/mobile/worker.md) shows, for each repository the
user can read, a stats page (quests by milestone, size, and state: ready,
blocked, waiting, claimed), the ready ranking in `quest unblocked`'s
order, the maintainer's waiting items in `quest waiting`'s order, and a
page per quest with its rendered Markdown, status, and claim PR. The pages
read well on a phone and an iPad in both orientations.

## Plan

- Restore kix's board (`src/board/`) and drive it from `quest/core`, so
  every count and order agrees with the CLI. Test that agreement by
  running the board model and the CLI on the same fixture trees,
  including invalid ones, which the page reports as invalid rather than
  half-rendering.
- Claims and drafts come from open PRs, read once per page through the
  user's token and cached briefly with the Cache API.
- Treat every quest file and PR body as untrusted: render Markdown with
  raw HTML escaped, as kix did, and bound how much one repository can
  make a page hold.
- Size colours always sit beside their labels and markers beside their
  states, as the theme requires.
- Benchmark and validate with the device bench (`cloudflare/DEVICES.md`)
  on the largest quest tree available (this repository's own).

## Required

- [Worker foundation](/quest/m2/mobile/worker.md) - the site, layout, and
  sign-in these pages live in
