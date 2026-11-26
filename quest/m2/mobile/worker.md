# [L] Worker foundation

## Goal

`cloudflare/` holds a Cloudflare Worker restored from kix and cut to this
epic's Goal: Hono pages rendered on the server with no client bundle, the
shared layout following `design/theme.md`, a web app manifest and service
worker so it installs on Android and iPad home screens and opens offline
to its last page, and GitHub sign-in through the
GitHub App (`cloudflare/GITHUB.md`) with Better Auth on D1. A
signed-in user sees the repositories the App is installed on that they can
read. `just check` and `just test` cover it, and a contributor can deploy
their fork to their own account's `workers.dev` subdomain.

## Plan

- Restore from kix's last tree (linked in the epic's Plan): the layout,
  site CSS and theme assets, `src/auth.ts`, the manifest and service
  worker, `scripts/build.ts`, and the tests for them. Cut jobs, runners,
  the inbox, push, passkeys, Google sign-in, the enrollment flow, and
  their migrations and secrets, and squash the remaining migrations into
  one, since nothing is in production.
- Authority comes only from GitHub on each request: the signed-in user's
  token and the App installation, never a cached role.
- The service worker caches the shell and the last rendered pages only,
  never API responses holding private repository data.
- Icons are `design/theme/logo.svg` exported at the manifest's sizes.
- Wrangler config names no hostname or account: those come from each
  deployer's environment, so a fork deploys without editing it.
- Validate with [device bench](/quest/m2/mobile/devices.md): install from
  the browser on both devices, sign in, and open offline.

## Required

- [Device bench](/quest/m2/mobile/devices.md) - validation on the
  physical Android phone and iPad
