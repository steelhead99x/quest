# [S] Device bench baselines

## Goal

The device bench (`cloudflare/DEVICES.md`) has run on a real Android phone
and iPad against the deployed site, any driver bug that run finds is fixed,
and each device model's baseline is recorded in `cloudflare/bench/`, so
later PRs compare against it.

## Plan

- The bench was built and tested against fake devices and a fake
  inspector, in a session that could not reach the contributor's devices.
  The first real run is the test of the adb, Chrome DevTools, and
  ios-webkit-debug-proxy paths: expect protocol differences, especially in
  Safari's target wrapping and `Page.snapshotRect`.
- Record baselines from the restored kix pages (`/` and a repository's
  board) once the [Worker foundation](/quest/m2/mobile/worker.md) deploys,
  with both devices charged and cool.

## Waiting

- steelhead99x: attach the Android phone and iPad to the contributor's
  machine and run `bun run device-bench --url <deployed site> --record` in
  `cloudflare/`, or give an agent session a shell on that machine to run
  it. Check it is done when `cloudflare/bench/` holds an `android-*.json`
  and an `ipad-*.json`.

## Required

- [Worker foundation](/quest/m2/mobile/worker.md) - the deployed pages the
  baselines measure
