# [S] Deploy the fork's quest log to quest.moq-bench.dev

## Goal

The contributor's fork (`steelhead99x/quest`) serves the quest log Worker
at `https://quest.moq-bench.dev`, signing people in through a GitHub App
owned by `steelhead99x`. Signing in there lists the fork, its board and
bench pages load, a quest page shows its PR's CI, and the site installs to
a phone's home screen.

## Plan

Decided 2026-11-25 (contributor): deploy the fork at quest.moq-bench.dev
first, under the contributor's own Cloudflare account and GitHub App, and
move to moq-dev once it is set up (the epic's Waiting has the upstream
hostname and App).

- Work from the branch holding the whole Worker
  (`quest/m2/mobile/bench` or wherever the stack lands), in `cloudflare/`.
  `cloudflare/GITHUB.md` and `cloudflare/DEPLOY.md` have the commands.
- Register the App with `bun run register-app --origin https://quest.moq-bench.dev`
  as `steelhead99x`, in a browser signed in to that account. In the App's
  settings, check that "Expire user authorization tokens" is on: the
  Worker refuses tokens without a refresh token and says so. Install the
  App on `steelhead99x/quest` only; installing it on `kixel-ai` or
  `moq-dev` repositories is the maintainer's call.
- Set `AUTH_SECRET` (`openssl rand -hex 32`) and the App's client ID and
  secret with `wrangler secret`, then
  `wrangler deploy --var GITHUB_APP_SLUG:<slug> --domain quest.moq-bench.dev`.
  The zone must be on the same Cloudflare account. Never commit
  `.github-app.json`, `.dev.vars`, or a token.
- Validate on the live site: sign in, open `/repos/steelhead99x/quest`, a
  quest page with an open PR, and `/bench`; check each response's
  `Server-Timing`; sign out and confirm the cookie and cached pages are
  gone. Then the [device bench baselines](/quest/m2/mobile/devices.md) run
  against it.

## Waiting

- steelhead99x: give the agent that takes this quest a way to deploy: a
  Cloudflare API token limited to Workers Scripts and the
  `moq-bench.dev` zone's Workers routes and custom domains, or a browser
  session signed in to Cloudflare and GitHub. Check it is done when
  `wrangler whoami` names the account that holds `moq-bench.dev`. An agent
  cannot create the account's first credential itself.
