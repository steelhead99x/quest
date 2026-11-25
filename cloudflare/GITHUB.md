# GitHub App

The Worker signs people in with a GitHub App and acts only through each
person's user token, so it never holds more access than they do on
github.com. The App has no webhook and the Worker keeps no installation
key.

| Permission    | Access | Used for                                        |
| ------------- | ------ | ----------------------------------------------- |
| Metadata      | read   | Repository names and visibility                 |
| Contents      | read   | The quest tree                                  |
| Pull requests | read   | Claims, drafts, and records in PR bodies        |
| Checks        | read   | A quest PR's check runs                         |
| Actions       | write  | Workflow runs, re-running failed jobs, dispatch |

`src/github/app.ts` holds the manifest. Each deploy registers its own App,
so a fork never needs the maintainer's credentials.

## Register

From `cloudflare/`, with the deploy's origin:

```sh
bun run register-app --origin https://quest.example.dev [--org my-org]
```

It serves a page on `localhost:8788`. Open it in a browser signed in to
GitHub as the account or organization owner, and press Create on GitHub's
page. GitHub sends the browser back with a one-time code, which the script
exchanges for the App's client ID and secret and writes to
`.github-app.json` with mode 600. Then:

```sh
bunx wrangler secret bulk .github-app.json && rm .github-app.json
```

and set `GITHUB_APP_SLUG` in `wrangler.jsonc` to the slug it prints, so the
site can link people to the App's install page. GitHub also generates a
private key for the App; the Worker never uses one.

## Install

Install the App from `https://github.com/apps/<slug>/installations/new` on
each account or organization whose repositories the site should show,
choosing the repositories. Then return to the quest log and select **Sign in**
to start authorization. A person sees a repository only when the App is
installed on it and they can read it on GitHub.
