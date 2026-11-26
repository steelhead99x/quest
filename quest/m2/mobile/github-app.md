# [S] GitHub App for the mobile quest log

## Goal

A checked-in GitHub App manifest, cut down from kix's, defines the App the
[Worker](/quest/m2/mobile/worker.md) signs people in with. Its user tokens
read pull requests, check runs, and workflow runs, and can re-run a failed
run or dispatch a workflow, never more than the signed-in user could do on
github.com. A `docs/` page says how to register it from the manifest,
install it, and set the Worker's secrets.

## Plan

- Permissions, all repository-scoped: metadata read, contents read, pull
  requests read, checks read, actions write. Rejected: kix's write access
  to contents, issues, pull requests, and checks, and its administration,
  secrets, and environments reads, which served jobs and its CI safety
  check, both cut.
- No webhook (agent's choice: pages read GitHub on demand through the
  Cache API, so there is no event state to keep; rejected: kix's webhook,
  which kept D1 in step for jobs).
- The callback URL and homepage come from the deployer's hostname, so a
  fork registers its own App from the same manifest.
- moq-bot stays the only App the host's daemons act as; this App acts
  only for signed-in people.

## Waiting

- Maintainer: register the upstream App from the manifest under the
  owner that installs it, and set its client ID and secret on the
  upstream Worker. Check it is done when signing in at the upstream
  hostname reaches GitHub's authorize page for that App. An agent cannot
  take this step: GitHub has no API to register an App, and it needs the
  owner's browser session. The contributor registers a separate App for
  their fork's deploy.
