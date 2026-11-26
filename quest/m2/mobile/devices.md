# [M] Device bench

## Goal

One command, run on a contributor's machine with an Android phone and an
iPad attached over USB, opens a given URL of the site on each device and
reports, per page and device: cold and warm load times (median and 95th
percentile over repeated runs), bytes transferred, the Worker's own time
from its `Server-Timing` header, whether the page installs as a web app
and opens offline, and screenshots in light and dark mode at the largest
text size. Its output pastes into a PR's `## Validation`, and it compares
against a stored baseline so a regression beyond run-to-run spread fails.

## Plan

- Drive Android Chrome over adb with the Chrome DevTools Protocol, and
  iPad Safari through ios-webkit-debug-proxy's WebKit inspector, both of
  which run on Linux and macOS (agent's choice: real browser engines on
  real hardware; rejected: emulators and simulators, which miss WebKit on
  iPad, thermal throttling, and Wi-Fi).
- It cannot run in CI, which has no attached devices: it is a
  contributor tool, and each quest here puts its run in its PR. Fail
  loudly when a device is missing, locked, or unauthorized, rather than
  skipping it.
- Measure time on the device from Navigation Timing, and check it a
  second way against the driver's own clock around each load, flagging
  runs where the two disagree beyond their spread.
- Report each device's model, OS, and browser version, battery and
  thermal state, so runs compare like with like; refuse to record a
  baseline from a throttled device.
- Store baselines in `cloudflare/bench/`, one file per device model, so
  contributors with other hardware add their own rather than overwrite.
- Bench the restored kix pages first, so the
  [Worker foundation](/quest/m2/mobile/worker.md) PR has a baseline to
  compare against.
