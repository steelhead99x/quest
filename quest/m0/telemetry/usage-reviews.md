# [M] Quest usage reads posted reviews from Kixel Quest

## Goal

`quest usage`, its breakage report, and the session sender's roles count every PR's local review the way they did when `quest review` wrote the PR body's `## Review` record: each PR's risk tier, class, and classifier, each reviewer's rounds, findings, and outcomes, and which sessions classified or reviewed it.
A PR `quest review` posted to Kixel Quest has no body record, so today those columns are empty for it and its reviewer and classifier sessions fall back to the role their skill or parent gives, outside the sender, which pins the role `quest review` queued.

## Plan

Found 2026-11-26 by the review of [kixel-ai/quest#931](https://github.com/kixel-ai/quest/pull/931), which moved the record to Kixel Quest.

Decided 2026-11-26 (maintainer, /quest-run): ✅ keep it (rejected: drop it, leaving `quest usage` without reviews posted after #931).

- Read the posted runs and outcomes of the window's PRs from Kixel Quest, and keep the body reader (`parseReview`, `recordedRisk`, `reviewSessions`, `classifierSessions` in `src/cli/review-record.ts`) for PRs reviewed before the posts, preferring a posted run where a PR has both.
- Take the reviewer and classifier session ids from the posted runs' rounds and classifier, so `sessionRecords` names their role in `quest usage` as it does in the sender.
- Agent's recommendation: read through the existing `/forge` client with the person's token, failing loud without it, as the instructions audit and routing readouts depend on these numbers.

Tests: a PR with a posted run and no body record reports its tier, reviewers, findings, and outcomes; its reviewer's session counts as reviewing; and a PR with only a body record reads as before.

## Waiting

- kixel-ai/kixel.quest: an endpoint answers a repository's posted review runs and outcomes for a window of PRs, which today only `/forge/status` reads one head at a time. Check that kixel.quest's `src/` routes a read of posted runs.
