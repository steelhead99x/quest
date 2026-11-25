# [S] Device bench baselines

## Goal

The device bench (`cloudflare/DEVICES.md`) has run on a real Android phone
and iPad against the deployed site, any driver bug that run finds is fixed,
and each device model's baseline is recorded in `cloudflare/bench/`, so
later PRs compare against it.

## Plan

- The bench was built and tested against fake devices and a fake
  inspector, in a session that could not reach the contributor's devices.
  Its Chrome DevTools path has run against desktop headless Chrome with
  adb faked, which found and fixed two bugs. The adb commands and the
  whole ios-webkit-debug-proxy path have not met a real device: expect
  protocol differences, especially in Safari's target wrapping and
  `Page.snapshotRect`.
- Record baselines from `/` and a repository's board once the Worker
  deploys, with both devices charged and cool.
- From each device, re-run a real failed workflow run and dispatch a
  workflow in the contributor's fork, and watch each start on github.com:
  the Worker's tests fake GitHub's Actions API.

## Waiting

- steelhead99x: attach the Android phone and iPad to the contributor's
  machine and run `bun run device-bench --url <deployed site> --record` in
  `cloudflare/`, or give an agent session a shell on that machine to run
  it. Check it is done when `cloudflare/bench/` holds an `android-*.json`
  and an `ipad-*.json`.

## Required

- [Deploy](/quest/m2/mobile/deploy.md) - the live site the baselines
  measure
