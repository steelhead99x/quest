# Worker

`cloudflare/` is the quest log site: a Cloudflare Worker that renders every
page on the server with Hono, in the theme of `design/theme.md`, with no
client bundle. `src/app.js` only registers the service worker (`src/sw.js`),
which caches the shell and the last 30 pages so the installed site opens
offline. Signing out sends `Clear-Site-Data`, which drops them.

People sign in with the GitHub App (`GITHUB.md`). The session is the cookie:
the App's user token and refresh token, sealed with AES-GCM under a key
derived from `AUTH_SECRET`, in an HttpOnly `__Host-` cookie. Expiring tokens
are refreshed on the next page, and signing out revokes the token on GitHub.
There is no database. Every form post must carry this site's `Origin`.

Every page sends `Server-Timing` with the Worker's own time and GitHub's, and
makes at most 40 GitHub requests, under Workers Free's 50 subrequests; a page
that would need more says so rather than showing part of its data.

The site takes its origin from the request, so the same build serves
`workers.dev`, a custom domain, or `localhost`.

## Develop

```sh
cd cloudflare
cp .dev.vars.example .dev.vars   # then fill it in
bun run dev                      # http://localhost:8787
bun run check                    # types, formatting, and a dry-run deploy
bun run test                     # the Worker's tests run inside workerd
```

## Deploy

With a Cloudflare API token that can edit Workers and the zone, and the App
registered for the deploy's origin (`GITHUB.md`):

```sh
cd cloudflare
openssl rand -hex 32 | bunx wrangler secret put AUTH_SECRET
bunx wrangler secret bulk .github-app.json && rm .github-app.json
bunx wrangler deploy --var GITHUB_APP_SLUG:<slug> --var SCHEDULE_TIMEZONE:<zone> --domain quest.example.dev
```

`SCHEDULE_TIMEZONE` is the IANA timezone, such as `America/Los_Angeles`,
whose calendar day decides when a `## Scheduled` date opens. The CLI reads
those dates on its own machine's calendar, so set the zone the maintainer
plans in; it defaults to `UTC`, and a name Intl doesn't know fails every page
with a 500 that says so.

The deploy also creates the `Rotations` Durable Object (SQLite-backed, on
Workers Free or Paid): one per refresh token, so a session refreshed from two
Cloudflare locations at once spends its single-use GitHub token once. Each
keeps the rotation for ten minutes, then forgets it.

`--domain` attaches the custom domain; leave it out to serve from
`workers.dev`. Nothing in `wrangler.jsonc` names an account, hostname, or
App, so a fork deploys without editing it.
