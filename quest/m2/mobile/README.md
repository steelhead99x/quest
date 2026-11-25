# Mobile quest log

## Goal

A cut-down kix: a Cloudflare Worker in `cloudflare/` serves a quest log
site that installs on Android and iPad home screens as a web app and
follows `design/theme.md`. People sign in with GitHub through a GitHub App.
It shows each repository's quest stats by milestone, size, and state, the
ready ranking, what waits on the maintainer, each claimed quest's PR with
its checks and workflow runs, and how merged quests performed. A signed-in
user can re-run a failed workflow run or dispatch a workflow. Every
user-facing PR is validated and benchmarked on a physical Android phone
and iPad.

Non-goals: kix's agent jobs, runners, decision inbox, push notifications,
passkeys, and Google sign-in; writing quests, merging, or answering
decisions from the site; native apps.

## Plan

Decided 2026-11-25 (contributor, /quest-plan in the fork
`steelhead99x/quest`, for the lead maintainer's approval before anything
lands upstream; the contributor then asked the agent to settle the
remaining choices, marked "agent's choice" below):

- Goal?
  - ✅ A cut-down kix: Worker site, home-screen install, GitHub App
    sign-in, quest board and stats, PR CI with re-run and dispatch, bench
  - Rejected: two native apps, Android and iOS (the first draft of this
    plan); one static web app with no server, which cannot finish
    GitHub's sign-in from the browser without one; kix plus push
    notifications, which needs VAPID keys and more D1 state; restoring
    all of kix, which reverses most of
    [moq-dev/quest#575](https://github.com/moq-dev/quest/pull/575)
- Style? ✅ `design/theme.md` as written, as kix's layout followed it
  (rejected: an 8-bit look, which the theme forbids with "no pixel art").
- Start from kix's code or from scratch? ✅ Restore kix's pieces this
  Goal needs from
  [its last tree](https://github.com/moq-dev/quest/tree/19c6602e4a137e96b974126c65b5e66e04def3c7/cloudflare),
  the parent of moq-dev/quest#575, and cut the rest (agent's choice:
  its layout, board, and sign-in were reviewed and tested; rejected:
  rewriting them).
- Milestone? ✅ m2 (agent's choice: it gates nothing in m0 or m1, and m2
  is where kix's mobile app was noted as dropped).
- How is it validated? ✅ On the contributor's physical Android phone and
  iPad, through [device bench](/quest/m2/mobile/devices.md), which every
  user-facing quest here requires (agent's choice: emulators miss real
  WebKit, thermal, and network behavior; rejected: emulators only).

## Waiting

- Maintainer: approve or reject bringing back part of kix. kix was
  deleted on 2026-11-08 because it never ran on a real repository, and
  the benchmark epic says the dashboard belongs to Kixel Code. Options:
  keep this cut-down kix here, since it adds nothing to the CLI and reads
  only what `quest/core` and GitHub already give it (recommended); move
  it to its own repository; drop the epic. An agent cannot settle this
  because it reverses a recorded maintainer decision.
- Maintainer: choose the Cloudflare account and hostname it deploys to
  upstream (quest.moq.dev was retired with kix). Until then the
  contributor deploys their fork to their own account's `workers.dev`
  subdomain. An agent cannot take this step: it needs the account owner's
  credentials and DNS.

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - its
  records endpoint is the long-term source for the bench page
