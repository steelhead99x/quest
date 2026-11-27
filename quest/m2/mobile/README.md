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
- Style? ✅ `design/theme.md`, which records the site's look: Quest's
  amber markers, size colours, and mark on moq-dev's slate and Signal
  Green, in Atkinson Hyperlegible Next (decided 2026-11-26, contributor,
  over three design passes; rejected: an 8-bit look, which the theme
  forbids with "no pixel art"; Barlow Condensed and Inter, then Bricolage
  Grotesque and DM Sans, both judged generic).
- Start from kix's code or from scratch? ✅ Restore kix's pieces this
  Goal needs from
  [its last tree](https://github.com/moq-dev/quest/tree/19c6602e4a137e96b974126c65b5e66e04def3c7/cloudflare),
  the parent of moq-dev/quest#575, and cut the rest (agent's choice:
  its layout, board, and sign-in were reviewed and tested; rejected:
  rewriting them).
- Sessions? ✅ The App's user token and refresh token sealed with AES-GCM
  in an HttpOnly cookie, with no database (agent's choice, on building the
  Worker: kix needed Better Auth and D1 for several sign-in methods,
  passkeys, and jobs, all cut here; rejected: restoring Better Auth on D1,
  which adds a dependency, migrations, and a database to deploy). GitHub's
  refresh tokens are single-use, so each sign-in has one `Rotations`
  Durable Object where its refreshes and its sign-out meet (decided in
  review, 2026-11-26: two Cloudflare locations refreshing at once, or a
  refresh finishing after sign-out, otherwise sign a person out or back
  in; rejected: sharing rotations through the Cache API, which stays in
  one data center).
- Milestone? ✅ m2 (agent's choice: it gates nothing in m0 or m1, and m2
  is where kix's mobile app was noted as dropped).
- How is it validated? ✅ On the contributor's physical Android phone and
  iPad, through the device bench (`cloudflare/DEVICES.md`), which every
  user-facing quest here runs for its `## Validation` (agent's choice: emulators miss real
  WebKit, thermal, and network behavior; rejected: emulators only).

## Waiting

- Maintainer: decide where the quest log site lives. Upstream has moved on
  since this epic was planned from fe7f02a (2026-11-16): on 2026-11-22
  ([kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104))
  the maintainer made kixel.quest "a public website and dashboard", and
  kixel-ai/quest's root quest now lists "storage, dashboards, and the merge
  queue, which kixel-ai/kixel.quest owns" as non-goals; its benchmark epic's
  report is kixel.quest's factory page, and its telemetry epic signs people
  in at kixel.quest with a free GitHub sign-in (`quest login`). This site is
  a dashboard with its own GitHub App sign-in. Options: move it into
  kixel-ai/kixel.quest as its phone view, on that sign-in and its factory
  data (recommended: it matches both decisions, and drops this site's App
  and sessions); keep it as the contributor's own site in this fork only;
  or bring it into kixel-ai/quest, which reverses the 2026-11-22 non-goal.
  An agent cannot settle this: it is the maintainer's product decision, and
  kixel-ai/kixel.quest is private to this contributor's sessions.
- Maintainer: choose the Cloudflare account and hostname it deploys to
  upstream (quest.moq.dev was retired with kix). Until then the
  contributor's fork is planned to serve at `quest.moq-bench.dev`; it does
  not serve there yet, and [deploy](/quest/m2/mobile/deploy.md) is done
  when it does. An agent cannot take this step: it needs the account
  owner's credentials and DNS.
- Maintainer: approve or reject the brand changes made in the fork for
  this site, before any reaches upstream. They reach past the site: the
  mark's dot redrawn as a commit node (`design/theme/logo.svg` and the app
  icons), the README's banner and lead line ("Find your next quest." and
  "Find the change that unblocks the most work."), the route-map art, and
  `design/theme.md`'s Voice and type. Options: take them all; take the
  site's look but keep the original mark and README (the fork can keep a
  site-only copy of the mark); or keep upstream's theme unchanged. An
  agent cannot settle this: the theme says to use the mark as is.
- Maintainer: register the upstream GitHub App with
  `bun run register-app` in `cloudflare/` (`cloudflare/GITHUB.md`), as the
  owner that installs it, and set its secrets on the upstream Worker. Check
  it is done when signing in at the upstream hostname reaches GitHub's
  authorize page for that App. An agent cannot press Create: GitHub has no
  API to register an App without the owner's browser session. Each fork's
  deploy registers its own App the same way.

## Related

- [Development as a benchmark](/quest/m0/benchmark/README.md) - its report
  is kixel.quest's factory page, built from Kixel Quest's records, which
  [the merged-quests page](/quest/m2/mobile/bench.md) is to read too
- kixel-ai/quest's `quest/m0/telemetry/login.md` - `quest login` signs a
  machine in to Kixel Quest; the sign-in this site would use if it moves
  there
