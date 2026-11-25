# [L] Android quest log app

## Goal

A native Android app in `apps/android/` shows the quest log for each
repository the user adds: a stats screen (counts by milestone, size, and
state), the ready ranking, the maintainer's waiting items, and a detail
screen per quest with its claim PR, that PR's check runs, and its workflow
runs. A signed-in user can re-run a failed workflow run or dispatch a
workflow. A bench screen shows [bench](/quest/m2/mobile/bench.md)'s data
once it lands. It follows the [pixel theme](/quest/m2/mobile/pixel-theme.md)
and works offline from the last feed it cached.

## Plan

- Kotlin with Jetpack Compose, minimum SDK chosen for the Keystore and
  Compose versions it needs, no third-party networking or JSON
  dependency unless the platform's cannot meet a stated need.
- Public data (the feed) loads without signing in; CI actions and private
  repositories need the [GitHub App](/quest/m2/mobile/github-app.md)
  sign-in.
- Treat the feed and every GitHub response as untrusted: check the feed's
  schema version, cap what is parsed, and show an error state instead of
  partial data.
- Unit tests cover parsing, the schema refusal, and stats arithmetic with
  mocked time. The debug build and unit tests run in the merge gate on
  Linux; instrumented UI tests run nightly.
- Validate on a real device or emulator: screenshots of each screen in
  light and dark, at the largest font scale, and a TalkBack pass.

## Required

- [Quest feed](/quest/m2/mobile/feed.md) - the data every screen reads
- [GitHub App](/quest/m2/mobile/github-app.md) - sign-in, CI reads, and
  re-run and dispatch
- [Pixel theme](/quest/m2/mobile/pixel-theme.md) - the shared look both
  apps implement
