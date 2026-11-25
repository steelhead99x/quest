# [M] PR CI and re-runs

## Goal

Each claimed quest's page shows its PR's check runs and workflow runs with
their state, duration, and a link to the logs. A signed-in user with write
access can re-run a failed run's failed jobs, or dispatch a workflow that
has a `workflow_dispatch` trigger, from the page. A repository page lists
recent workflow runs on the default branch.

## Plan

- Every action is a form POST that rechecks the user's GitHub access and
  the configured origin before calling GitHub, as kix's forms did, and
  shows GitHub's answer rather than assuming success.
- Never approve or re-run a run waiting on approval for an outside
  contributor's PR: that runs code from someone without write access.
  Hide the buttons on such runs and say why.
- Keep each page within Workers Free's 50 subrequests, the limit kix
  designed its reads around: page through runs with a fixed budget and say
  when more exist rather than reading them all.
- Validate on [device bench](/quest/m2/mobile/devices.md): re-run a real
  failed run in the contributor's fork from each device and watch it
  start on github.com.

## Required

- [Quest board](/quest/m2/mobile/board.md) - the quest pages this adds
  CI to
- [Device bench](/quest/m2/mobile/devices.md) - validation on the
  physical Android phone and iPad
