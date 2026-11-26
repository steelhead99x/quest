# [L] Sync the fork with upstream's main

## Goal

The fork's `main` merges kixel-ai/quest's `main`, which is 155 commits
past the fork's base (fe7f02a, 2026-11-16) as of 9029c02 (2026-11-26), so
the fork runs upstream's current CLI and anything it offers upstream
applies there. `just check` and `just test` pass at the root, and
`bun run check`, `bun run test`, and `bun run demo:e2e` pass in
`cloudflare/`.

## Plan

- Merge upstream's `main` into a branch from the fork's `main`; never
  rebase the fork's landed history.
- Upstream wins wherever it changed the CLI: it deleted `quest eval`,
  reworked model routing and risk tiers, and moved records, review posts,
  and forge reads to Kixel Quest. Keep the fork's moves (`parseReview` to
  `src/core/review.ts`, `HARNESSES` to `src/cli/models.ts`) only where the
  Worker still imports them, and rebuild those imports on upstream's code.
- Upstream's quest tree wins on upstream's own quests: take its `quest/`
  as it stands, keeping only the fork's `quest/m2/mobile/` and the quests it
  links. The fork's copies of upstream quests from before fe7f02a go.
- The fork-only changes to `README.md`, `design/`, `flake.nix` (Node for
  Wrangler), and `cloudflare/bunfig.toml` carry over; where upstream
  changed the same lines, keep upstream's and reapply the fork's intent.
- The four CLI fixes land upstream separately
  ([upstream CLI fixes](/quest/m2/mobile/upstream-cli-fixes.md)); keep the
  fork's copies until upstream merges them.

Tests: the suites above; `quest check` on the merged tree.
