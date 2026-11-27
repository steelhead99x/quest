# [XS] Finish the fork's stalled release

## Goal

The fork's latest release run
([45853839937](https://github.com/steelhead99x/quest/actions/runs/45853839937))
publishes all six binaries and passes its install check. GitHub never gave
its Apple Silicon job a hosted runner, for lack of capacity; the build and
the other five binary checks passed, and publishing and the install check
were skipped.

## Plan

- Once the job reruns, confirm the release is published with all six
  binaries and the installer, and that the install check passed.
- If the fork's main has moved on by then, a fresh release run from it
  serves as well as the rerun.

## Waiting

- Contributor: rerun the failed Apple Silicon job on GitHub once runners
  are available. An agent session here cannot: it has no access to the
  fork's Actions.
