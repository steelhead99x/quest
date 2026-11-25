# [M] GitHub App for the mobile apps

## Goal

A GitHub App manifest, checked in, defines the app both phones sign in
through. Users sign in with GitHub's device flow, so neither app holds a
client secret and nothing is hosted. With the user's token the apps read
pull requests, check runs, and workflow runs, and can re-run a failed
workflow run or start a `workflow_dispatch` workflow, never more than the
signed-in user could do on github.com.

## Plan

- Permissions, all repository-scoped: metadata read, contents read, pull
  requests read, checks read, actions write (re-run and dispatch). No
  webhooks, since nothing is hosted to receive them.
- Device flow: show the user code and open github.com/login/device; poll
  at the interval GitHub returns. Store the user token and its refresh
  token in the Android Keystore and the iOS Keychain, refresh on expiry,
  and sign out on a refresh failure rather than retrying.
- The apps never approve a workflow run waiting on approval for a
  first-time or outside contributor's PR, and hide re-run on such runs:
  that runs code from someone without write access.
- A short `docs/` page says how to register the App from the manifest and
  install it on a repository.

## Waiting

- Maintainer: register the App from the manifest under the owner that
  installs it, enable the device flow, and put its client ID in the apps'
  build config. Check it is done when the device flow returns a user code
  for that client ID. An agent cannot take this step: registration needs
  the owner's browser session, and GitHub offers no API to register an App.
