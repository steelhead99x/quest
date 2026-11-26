---
description: Queue a PR to land, running /quest-iterate first when it needs work.
guide: Creation, Deletion, Summaries, Questions
---

Run this in the session that picked the PR, never in a sub-agent of its own: it only decides whether the PR's head can land as is, and queues it.
It never fixes the PR, pushes, or waits on GitHub; a head that needs work goes to `/quest-iterate`, and the merge gate handles conflicts and failures after queueing.

The argument is the PR; without one, it is the current branch's.
It takes no hold, since it never pushes: release one you hold from another skill in this session with `quest release <pr> <token>` first.

Read the PR with one `quest status <pr>`.
If a `hold` record shows another session holds it, stop and report it; taking over a hold is the user's choice.
The head is landable when:

- the PR is not a draft;
- a review counts for it, as below;
- every finding a local reviewer posted on it, or a person in a review of their own rather than an `Automated review by <name>` one, is fixed on the head, answered with a refutation, or, for a local reviewer's, accepted by the maintainer with `quest review --accept`, no decision is open, and `quest status` prints no `signal` line, which also covers an online reviewer the base requires; an optional online reviewer's findings, such as CodeRabbit's where the base requires none of its checks, never hold a pick, unless the base requires conversation resolution: then `quest status` prints no `thread` line, optional reviewers' threads included;
- no check failed on it, required or not, a failing `quest review` status included, its required checks passed, other than the gate's own `quest land` check, which never reports on a head, and it does not conflict with its base;
- `quest status`'s `review-decision` is not `changes_requested`; an approval its base requires may still be to come, since the queue waits for it.

While its required checks are only pending, report that the pick stands until they pass; do not wait for them.
A change request that stands once its findings are fixed or refuted and their threads resolved is the user's call.
Any other head needs `/quest-iterate`: run it, saying what the head needs, such as a review, fixes, a failed check fixed or rerun, flaky ones included, or decisions, then run this skill again once it finishes; if it stops for the user instead, report that.
Run it in this session, where its interview can ask the user; under a coordinator such as `/quest-run`, return the PR to the loop, which dispatches it in a sub-agent.
A PR that adds follow-ups also needs the pick round's answers recorded before queueing, as the guide's Creation section describes: ask about each follow-up that round has not asked, in a question of its own, then run `/quest-iterate` with the answers unless the head already records them.

A review counts for the head its `## Review` record names: a local `quest review` round.
Read `quest status <pr>`'s `review-record` line rather than comparing diffs yourself: `current` or `diff-identical` (the head's diff from the base is unchanged since the reviewed head) counts.
A record whose `Risk file` line is not the base's `RISK.md` blob at its tip (after `git fetch <remote> <base>`, `git rev-parse --short=12 FETCH_HEAD:RISK.md`, `none` where absent) counts for no head, the one it names included, until a new `quest review`: its tier decided how much review the head got. `quest status` reads it as `stale`, with a warning on GitHub that the record covers the head no longer, so check the line yourself where it prints none.
Otherwise, the changes since the reviewed head need no new review only when they are conflict-free merges from the base branch, a reviewer's suggested patch applied unchanged, a land fixer's recorded mechanical fix, pushed by its bot, that changes no behavior, or the pick round's answers recorded in the PR's follow-ups.
`quest status` counts a record only through the passing `quest review` commit status a maintainer's round set on the head it names, so a contributor's head needs a maintainer's local review; the repository's review policy may require more.
An online reviewer's approval never stands in for that record.
A low head's record counts without a local reviewer; a later head's rise in tier ends the pick: tell the user.

Queue the head with `quest merge <pr> --land <full 40-character head SHA>`, adding `--squash` or `--rebase` when the repository's root instructions name that method for the PR's base.
Run a `quest` the PR cannot modify, such as an installed release rather than a build from the head's checkout: it refuses a head that leaves its quest inaccurate, a check the head's own code could skip.
A refusal says what the head or the repository needs: follow it, sending a head that needs a fix or its base merged to `/quest-iterate`.
Ask instead when it refuses a head `/quest-iterate` left unchanged, and never pass `--direct` unless the user explicitly asks.

Report once it is queued, and do not wait for it to merge.
A PR that left the queue unmerged shows why under `landing-stopped` in `quest status <pr>`; it needs the user's pick again, except where `/quest-run` says an earlier pick still holds.
Never close a PR to unstick it, and never work around a refused merge; ask instead.

Ask the user for the pick with your recommended action, one of `/quest-merge`, `/quest-iterate`, skip, or delete, plus `/quest-merge` when you recommend another, "Explain it first", and "Rethink it".
"Rethink it" starts a fresh background sub-agent, given the PR, its reviews and threads, and its quest's Goal, Plan, and evidence (read the deleted file on the base), not your recommendation, to start from scratch: brainstorm other approaches to the problem, decide whether this PR is the best path forward, and recommend merging it, iterating toward a named alternative, or dropping it.
Ask again without it, its recommendation beside yours, and where they differ.
