---
description: Review a PR's branch locally with a model no weaker than its latest writer, then mark it ready for review.
guide: Creation, Execution, Summaries, Questions
skills: merge
---

The argument is the PR; without one, it is the current branch's.
If its body lists open decisions, other than its follow-ups', or unfinished work, offer `/quest-iterate` first.

Take the PR with `quest iterate <pr> [token]`, passing a hold token your brief gives or you already have, and keep the token it prints.
If it refuses, stop and report what it printed; taking over a hold is the user's choice.
The exception is a draft with no `## Waiting` section, which is still its starter's: when you started it, or its starter delegated this review to you, review it without a hold.

Work in a checkout of the PR's head, detached when another worktree holds its branch.
Whenever your checked-out branch is not the PR's head branch, pass `--branch <head-branch>` to each `quest review`, so its rounds and record follow the PR.
Commit everything, and unless the repository's local checks already passed on that commit, run them and fix any failure the branch causes.
A PR whose author lacks write access gets no local run: leave its checks to the merge queue, and run a `quest` it cannot modify, such as an installed release, from outside its checkout with `--root`.
A check failure that reproduces unchanged in a checkout of the base branch is pre-existing rather than the PR's: record the command and both failures in the PR body's validation, go on to review and readiness, and add a follow-up for it unless an open PR already fixes it.
Never alter the repository's harness to get a pass, such as by disabling a tool, unsetting its environment, or skipping a check, nor report an altered run as its checks.

Run no new round when a review already counts for the committed head, as `/quest-merge` defines below, and leaves no finding unrefuted or unaccepted: go on to marking it ready.
`quest status <pr>` reads the pushed head, so trust its `review-record` line only while its `head` line is the committed head.

Otherwise, push the committed branch unless GitHub already has its head, since each round's status goes on the head GitHub has, first disabling auto-merge with `gh pr merge <pr> --disable-auto` when `quest status <pr>` shows it enabled, since GitHub would land the pushed head unreviewed, then review it with `quest review --base <remote>/<base>`, in the foreground; a round takes minutes.
It picks a reviewer no weaker than the model that changed the branch last, which may be that model, at an effort the PR's size sets.
It reads that model, and off a quest branch the size, from the PR body's `## Models` record: open the draft PR and write the record before the first round, as `Size: M` and `Implementer: Claude Code, claude-opus-5-5, high effort`.
Pass `--exclude-model` or `--size` only for a PR whose body cannot hold the record; `--exclude-model` also bars the model it names, so do not name the writer.
Where the repository's root instructions name other reviewers, pass them with `--harness`, `--model`, and `--effort`, which runs that reviewer alone.
Each round posts to Kixel Quest, which needs `quest login` on the host, and, on GitHub, sets the head's `quest review` commit status; it leaves the PR body alone. When it printed `record skipped`, run it again once the branch has its PR, since `quest status` counts only a round `quest review` posted, and only a maintainer's: a contributor's own round prints `status skipped`. At `status refused`, or a post Kixel Quest refused, fix what it names, such as pushing the head, and review it again.

`quest review` sets the head's risk tier before any reviewer runs, from who a mistake in the change would reach, then seats reviewers from its `(size + risk)` rung: every low head runs a local reviewer, rungs 0–2 (`XS low/medium/high`, `S low/medium`, `M low`) run one reviewer, and rungs 3–6 (`S high`, `M medium`, `L low` and up) run both Sol and Opus beside each other.
When the user overrides the tier, pass it with `--override <tier> --reason <their reason>`.

Each round ends with a `next` line: follow it until a round of the head reports no finding you have not refuted; never block on the score.
A finding names a way someone is hurt and ends with the fix its reviewer recommends: make that fix, the smallest that settles it, unless you refute the finding. Do not answer a finding with a design of your own.
Notes are yours to take or leave, and need no answer: take one only when it is plainly right and cheap.
Refute a finding only with evidence the reviewer cannot rebut: a `path:line`, a command's output, or a recorded maintainer decision. That its scenario needs a host, user, or configuration the project does not have is such evidence, cited from where the project says so.
A finding the reviewer keeps against such a refutation is a decision for the user: once they accept it, run `quest review --accept <their reason>` on the pushed head, which records the open findings as accepted and passes the head without another round; otherwise fix or refute it.
Write each round's `--responses` file in the checkout's `.tmp/`.

At a `next decide` line, which prints once a reviewer's third round still reports findings, stop: fix nothing more, change no approach, and run no further round. `quest status <pr>` prints a `checkpoint` line when the third round of an online reviewer the base requires does the same.
Report what remains, a line per finding with the fix its reviewer recommends, and recommend one of: fix them as recommended, accept them, or drop the PR. The user decides; an agent that cannot prompt hands the PR back with that choice as a `## Waiting` decision.
Take up a reviewer's recommended approach only on the user's pick. Record it in a PR comment that starts with `Design change:`, and review it with `quest review --new`, which starts new sessions and keeps what the branch already settled.

On a one-seat rung, `quest review` passes a round from a reviewer that is out of quota, logged out, or not installed to the rung's next eligible one, and records the skip; on a two-seat rung, both seats are required, so either one being unavailable fails as an outage.
Once it exits 3, a required reviewer or every eligible reviewer is out, an outage rather than a skip: stop reviewing, keep the PR a draft, hand it back, and report the outage.
Its `## Waiting` item names each reviewer, its error, and the check, such as `Codex: out of quota until 2026-11-03 15:00 UTC; check that quest review runs`, with the reset time `quest review` prints; a logged-out or missing reviewer waits on `Maintainer (PC):`, with the login command `quest review` prints, since the login runs on the reviewer's host.
Once the reset passes or the login is restored, the item has cleared: whoever finds it runs `/quest-review` on the PR.

Push any commit not yet pushed, resolve each `duplicate` line `quest status <pr>` then prints as the guide's Creation describes, then mark the PR ready for review: with `quest ready <pr> <token>`, which also drops its `## Waiting` section, or with `gh pr ready <pr>` for a draft you reviewed without a hold.

Summarize the review, with its last round's score and rationale, any reviewer's recommended approach with your take on it, and CI from `quest status <pr>`.
Name any decisions the review raised without answering them, then ask the user for the pick with `/quest-merge`'s options.
Recommend `/quest-merge` when the PR is landable as it defines, or will be once fixed with no decision left for the user, such as failing checks or a required online reviewer's unaddressed findings, since `/quest-merge` runs `/quest-iterate` first; recommend `/quest-iterate` when the review raised significant issues or decisions.

While its required checks are still running, report that instead of asking; `/quest-run` asks once they finish.

If you took a hold, hand the PR back with `quest release <pr> <token>` before you ask, report, or go on to `/quest-merge`.
To go straight on to `/quest-iterate` in this session, pass the token to its `quest iterate` instead, which keeps the hold.
