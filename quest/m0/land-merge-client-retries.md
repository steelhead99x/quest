# [S] Stop the GitHub client's own merge retries when a PR is withdrawn from the queue

## Goal

When `mergePinned`'s `PUT /pulls/:number/merge` is resent by the GitHub client itself, after a rate-limit wait or a 5xx or dropped connection, the pick's auto-merge is re-checked immediately before the resend, and a withdrawn or re-armed pick takes the `Left the queue` path instead of merging.

## Plan

Found 2026-11-27 by the `quest review` round of the PR that fixed `mergePinned`'s own retry branches (it re-reads the pick before each of those).

- `GitHub.request` (`src/github/client.ts`) waits out a rate limit with `waitOut`, up to an hour for a daemon (`quota: "wait"`), and repeats the PUT with the same pinned SHA, with no check of its own. After a 5xx or dropped connection it pauses 1 to 8 seconds, then runs the merge's `repeat` check (`repeatable`), which only recognises a merge that already happened. A maintainer who disables auto-merge in either window leaves the head unchanged, so the resend can merge a withdrawn PR.
- Recommended: let `mergePinned` pass its own `repeat` for the merge PUT that also re-reads the pick (`armed` in `src/cli/land-head.ts`) and throws a typed withdrawal error that `mergePinned` turns into `left_queue`, and have `request` run a function `repeat` after a rate-limit wait as well as after a transient failure. Check `test/github.test.ts` for tests that count requests across a rate-limit wait.

Tests: a withdrawal during a rate-limit wait and during a 5xx pause each end the landing as `Left the queue` without a second merge request.
