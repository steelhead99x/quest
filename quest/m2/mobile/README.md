# Mobile quest log

## Goal

A native Android app and a native iOS app, built separately, show a
repository's quest log on a phone: the tree's stats by milestone, size, and
state, the ready ranking, what waits on the maintainer, each claimed quest's
PR with its CI, and how merged quests performed. A signed-in user can re-run
a failed workflow or start a dispatchable one from the phone. Both apps sign
in through a GitHub App with no server of their own, and follow the quest
log theme in `design/theme.md`.

Non-goals: writing quests, merging, or answering decisions from the phone;
any backend or hosted service; tablet-specific layouts.

## Plan

Decided 2026-11-25 (contributor, fork planning session): planned in a fork,
`steelhead99x/quest`, for the lead maintainer to approve before anything goes
upstream. m2 holds it because it gates nothing in m0 or m1.

- Where does the data come from?
  - ✅ A published JSON feed built from the CLI's existing `--json`
    output, so neither app parses quest Markdown
    ([feed](/quest/m2/mobile/feed.md))
  - Rejected: parsing the tree on the phone, which duplicates
    `src/core/` in Kotlin and Swift; a new `quest` subcommand, which adds
    CLI surface the existing `unblocked --json` and `waiting --json`
    already cover
- How do the apps reach GitHub?
  - ✅ A GitHub App with the device flow for user tokens, so there is no
    client secret or server to host ([GitHub App](/quest/m2/mobile/github-app.md))
  - Rejected: personal access tokens pasted into the app; an OAuth App,
    whose tokens cannot be scoped per repository
- One codebase or two? ✅ Two native apps, Kotlin on Android and SwiftUI
  on iOS, each small enough that a cross-platform toolkit costs more than
  it saves (rejected: Flutter, React Native, Kotlin Multiplatform).
- Style? ✅ The existing quest log theme, `design/theme.md`, applied to
  native screens: size colours with their labels, the `!` and `?`
  markers, and `logo.svg` ([mobile theme](/quest/m2/mobile/theme.md)).
  Rejected: an 8-bit look, which the theme forbids ("no pixel art").

## Waiting

- Maintainer: approve or reject the scope. The benchmark epic lists "a
  dashboard in `quest` itself, which Kixel Code owns" as a non-goal, and
  m2's README records that kix's mobile app was dropped on 2026-11-08.
  Options: keep this epic here, since it adds no code to the CLI and only
  reads what it already prints (recommended); move the apps to their own
  repository and keep only the feed workflow here; drop the epic. An
  agent cannot settle this because it reverses a recorded maintainer
  decision.

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - its
  records endpoint is the long-term source for the bench screen
- [Records endpoint](/quest/m0/benchmark/records-endpoint.md) - what
  [bench](/quest/m2/mobile/bench.md) switches to once it serves records
