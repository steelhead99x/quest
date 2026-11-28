# [S] Read from GitHub, the review record comes from quest review's commit statuses

## Goal

Read from GitHub, `quest status`'s `review-record` and `risk` lines come from the PR's `quest review` commit statuses, the source the land gate (`unreviewedHigh`) already trusts, so they agree with what `quest merge` takes and no PR body edit can drop a review that counts.
The PR body's `## Review` record is no longer read by `quest status`.

## Plan

Found 2026-11-27 (maintainer, from a kixel-ai/rind session): two agents rewrote PR bodies after `quest review` had run, deleting its `## Review` record, so `quest status` printed `review-record -` and `/quest-merge` could not land [kixel-ai/rind#1103](https://github.com/kixel-ai/rind/pull/1103) (head `42a59456`) or [kixel-ai/rind#1139](https://github.com/kixel-ai/rind/pull/1139) (head `4d9bc1a6`) until `quest review` reran on the same head only to rewrite the record.
rind pins `quest` at 9529618, before [kixel-ai/quest#931](https://github.com/kixel-ai/quest/pull/931) moved each run's record from the body to Kixel Quest, so rind's own fix is bumping that pin, which is rind's work.

What is left here: when Kixel Quest does not serve the repository, or the person is not logged in or sets `QUEST_FORGE=github`, `forgeFor` reads GitHub, where `trustedReview` (`src/github/review-trust.ts`) still counts only a body record, which no `quest review` since #931 writes. Every head reviewed since then reads `review-record -` there, though its commit status attests the review and `quest merge` would land it.

Options weighed for the maintainer's goal, that a body edit can no longer silently drop a review that counts:

- ✅ Recommended: derive the record from the commit statuses, the source of truth, which also deletes the body reader from `quest status`. Nothing else needs to change once nothing reads the body.
- Rejected: a body-edit helper agents use instead of `gh pr edit --body-file`, since #931 no body holds a record to keep, and agents would still reach for `gh`.
- Rejected: a hook refusing a body edit that drops `## Review`, for the same reason, and it would only cover sessions with Quest's hooks installed.

Guidance:

- Walk the `quest review` statuses on the PR's current commits as `unreviewedHigh` does (`reviewStatuses`, `boundStatus`), so a reviewed commit a force-push dropped from the PR counts for nothing, as at the land gate: the newest writer's status bound to a diff equal to the head's, or on a commit the head only cleanly merged the base since (`BaseMerges`), counts when it passed. `current` when it is on the head, `diff-identical` when its diff matches the head's or the head only cleanly merged the base since, `stale` when only an older diff passed; `localReview` from whether the outcome is `passed with no local reviewer`; `risk` from the status's tier and class, `stale` once the base's risk file moved, with `-` for the classifier's tier and the reason, which the status does not carry: its tier is the final one, after any reviewer raised it. Share the walk with `unreviewedHigh` rather than copy it, so the two cannot disagree.
- Delete `trustedReview`, `attestedOutcome`, and the GitHub status path's body parsing, and update the README's `review-record` and `risk` rows, `quest status --help`, the warning in `src/cli/main.ts`, and `/quest-merge`'s line on reading from GitHub. `quest usage` keeps its body reader for PRs reviewed before #931, which [usage reviews](/quest/m0/telemetry/usage-reviews.md) owns.

Tests: read from GitHub, a head with a writer's passing status reads `current` with its tier; a later push with the same diff reads `diff-identical`; a push changing the diff reads `stale`; a force-push that only rewords the reviewed commit's message reads `-`, so it needs a new review; a non-writer's status, a failed status, and a status bound to another base each count for none; a body without `## Review` changes nothing; a `passed with no local reviewer` status reads `no-local-review`. Verify a second way on a real PR: `QUEST_FORGE=github quest status` and the Kixel Quest read print the same `review-record` for a head reviewed since #931.

## Related

- [Usage reads posted reviews](/quest/m0/telemetry/usage-reviews.md) - keeps the body reader for `quest usage`'s older PRs
