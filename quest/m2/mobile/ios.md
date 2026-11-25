# [L] iOS quest log app

## Goal

A native iOS app in `apps/ios/` has the same screens and behavior as the
[Android app](/quest/m2/mobile/android.md): stats, the ready ranking,
waiting items, per-quest detail with its PR's checks and workflow runs,
re-run and dispatch for a signed-in user, and the bench screen once
[bench](/quest/m2/mobile/bench.md) lands. It follows the
[mobile theme](/quest/m2/mobile/theme.md) and works offline from the
last feed it cached.

## Plan

- SwiftUI with Foundation's networking and `Codable`, no third-party
  dependencies. Generate the Xcode project from a checked-in XcodeGen
  spec so no `.xcodeproj` is committed.
- Built independently of the Android app: each implements the shared
  feed schema and theme spec, and neither shares code with the other.
- The same untrusted-input rules as Android: schema version check,
  bounded parsing, error states instead of partial data.
- Unit tests for parsing, the schema refusal, and stats arithmetic run
  nightly on macOS, since a macOS runner is too slow and costly for the
  merge gate.
- Validate in the simulator and on a device: screenshots of each screen
  in light and dark, at the largest Dynamic Type size, and a VoiceOver
  pass.
- Distribution (TestFlight or ad hoc) is a follow-up once the maintainer
  says who should install it.

## Hosts

- macos - Xcode builds and runs the app and its tests

## Required

- [Quest feed](/quest/m2/mobile/feed.md) - the data every screen reads
- [GitHub App](/quest/m2/mobile/github-app.md) - sign-in, CI reads, and
  re-run and dispatch
- [Mobile theme](/quest/m2/mobile/theme.md) - the quest log theme
  both apps implement
