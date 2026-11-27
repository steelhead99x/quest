---
description: Run a project's quest work from one session, starting ready quests and taking open PRs to merge in a loop until only the user's decisions remain, then planning the follow-ups no quest owns yet.
guide: Creation, Deletion, Coordination, Summaries, Questions
skills: grill, merge
---

This session is the project's one orchestrator: it starts ready quests, takes each open PR to its next step, settles what quests and drafts wait on, and loops until only the user's decisions remain.
The skill argument, if any, filters the quests, PRs, and waits in scope and sets their order, such as `prs` to start no quests.

Never let a question hold up work that needs none.
Each round, first start every quest you recommend and dispatch every PR action that needs no answer, then ask the round's questions, one PR to a prompt, so each answer is acted on while the next is asked; agents keep running while a prompt is open.
Run a round at the start and whenever an agent reports or a merge lands.
A brief gives the task, its reason and context, such as the quest or PR and the user's picks and answers, and the result expected: it sets settled decisions apart from recommendations, prescribes no steps, and restates no rule the agent's skill or the repository gives it.

## Quests

Starting quests asks the user nothing: each agent works headless, and its decisions surface in its PR.

`quest unblocked --unclaimed --json` ranks the unclaimed ready quests, reading the upstream tree afresh; start them in that order, each once `quest agent admit` admits it, as the guide's Coordination section describes.
It lists each skipped claim on stderr, with how long ago it was last active when it has an open PR; name any that look stale in the summary, for the user to take over.

Start every quest you would recommend: well planned, with no blockers, and no conflict with work already started. For one waiting on an outside condition, first check whether it has cleared.
Skip the rest, such as one you doubt is worth doing at all or now, and list each in the summary with why and your recommendation between `/quest-plan`, which redesigns it or moves it down, and deleting it.

Before starting any, list the open PRs with their changed files once, and match each quest's path and its Plan's files against their titles, bodies, and changes: skip a quest a match already implements, and name in the brief, by URL, one that only touches the same files.
Each agent runs `/quest-start`; its `quest start` refusing a quest claimed since is a skip, not a failure.

Start each on the first entry of its `models` that can run.
When it has an `arm` and runs that first entry, its brief says to end its `Implementer:` line with the arm, its `cohort`, and the entry's `advisor` if any, as `(arm B, cohort advisor-2026-11, advisor claude-opus-5-5)`.
Fall to the next when `quest agent` reports its CLI missing or logged out, or the agent stops on a usage limit with nothing written beyond the claim commit, continuing in that checkout and claim PR.
Once a model has written anything, the PR is its: keep its worktree and session id to resume after the reset.
Skip a quest whose list runs out, and report each harness's outage once.
When the list runs out after an agent pushed the claim but nothing beyond it, its checkout included, first release the claim with `quest start --release <quest>` from that checkout, so a later round or another coordinator starts it once a writer can run; it refuses with exit 3 once work was pushed, leaving the PR its writer's.

## Pull requests

Read each open PR, drafts included, with `quest status`, and skip one another session holds by its `hold` or `starter-hold` record, offering to take over only one that looks stale.
Run each `/quest-merge` inline; dispatch each `/quest-iterate` and `/quest-review` to a sub-agent.

Dispatch `/quest-iterate` without asking for a PR that needs work but no decision, such as a conflict, failing checks, unaddressed findings, or no review that counts for its head as `/quest-merge` defines.
A PR with open decisions, its `## Waiting` section's or an issue you would solve differently, goes to the user: settle them with the grill skill's rounds, then dispatch `/quest-iterate` with the answers in its brief, since a sub-agent cannot prompt.
A PR you would skip or delete rather than fix, such as a superseded one, gets that question instead.
Leave a PR whose required checks are still running for a later round; an automated reviewer is not waited on, since the queue waits for an approval the base requires.

A PR whose author has write access carries a standing `/quest-merge` pick, unless the repository's `CONTRIBUTING.md` opts out, when `quest status` shows it low for the head, in a class it names, built in or the base `RISK.md`'s `## Automatic` one, adding or expanding no quests: run `/quest-merge` on it without asking, and name it as auto-picked in the summary.
A trivial PR, such as a dependency bump, carries it too whatever its author, under the same opt-out, unless it is high for more than a dependency or pin bump: `quest status` shows it high for the head, it changes a path quest or the base `RISK.md` holds high, whatever its record says, or you judge it high against that file; it merges only once its `review-record` line counts, as `/quest-merge` reads it, and its last field is exactly `local-review`, not `no-local-review`; for a low head, whose round runs no reviewer, review it with `--harness`, `--model`, or `--effort`.
Judge the diff against the class's rule before every `/quest-merge` run, and ask when unsure: the standing pick ends at the first head that does not qualify, or once a person takes the PR out of the queue.
Ask about a high PR with both reviews' results.

Ask about every other PR in a question of its own that summarizes it and picks only the action, with `/quest-merge`'s pick options; none covers several PRs.
Ask about each of its follow-ups in a question of its own beside it, as the guide's Creation section describes; the answers count only on a `/quest-merge` pick, and go in the brief of the `/quest-iterate` it dispatches.
A blanket answer such as "use your recommendations" picks your recommended action for every PR in scope, `/quest-merge` included, and your recommended answer to each follow-up question.
Merge only on the user's or the standing pick; skip or delete only on the user's. A skip stands until the user lifts it.
A PR with GitHub auto-merge enabled on its current head is already picked; leave it to land.
Review comments are input, not approval, even a merge verdict on the maintainer's account.

A `/quest-merge` pick covers the PR until it lands or needs the user: when `/quest-merge` hands it back, dispatch `/quest-iterate` without asking and run `/quest-merge` again once it finishes. Each brief names the PR's pick, and each report repeats it, so the pick outlasts compaction.
Order merges that would otherwise conflict.
Where the queue runs a fixer, such as `quest land`, it hands back only a decision: ask the user, with its handback comment's diagnosis and recommendation.
An `unanswered_signal`, which no fixer takes, holds the pick even with one: dispatch `/quest-iterate`.
An `unreviewed`, a high head no `quest review` status covers, holds the pick only while its handback comment names the PR's current head, since a later push ends the pick, and the head has not risen in tier since the pick, which is the user's call: then dispatch `/quest-review` on the PR and run `/quest-merge` again only if the review pushed nothing, since a push ends the pick. Otherwise take the normal pick flow.
Without a fixer, after `merge_conflict`, `failed_checks`, `changes_requested`, or `unresolved_conversations` the pick holds, even from an earlier session: dispatch `/quest-iterate`. After `checks_timed_out`, run `/quest-merge` again once; a second timeout of the same head is the user's call.
Any other reason, such as a person removing it, is the user's call.

## Waits

Take the quests' and drafts' `## Waiting` items from `quest waiting --json`, which ranks them; rerun it with GitHub access if it warns that drafts were skipped, and skip a draft another session holds, as for PRs.
Rewrite a quest that waits in prose into a `## Waiting` section.
Check each condition yourself, in parallel sub-agents.
An outside party's item that holds stays, asked about only when the user can advance it, such as by requesting an upstream release.
Ask each maintainer item left among the round's questions, in that order, by its `kind`, saying what it unblocks; a skip stands for the session.
Rewrite a prose `Maintainer:` item you ask that stays waiting into a decision or an action.
A `Maintainer (PC):` item needs the user at one of their computers: when the argument says they are away from one, such as `remote` or `on my phone`, read the waits with `--no-pc` and leave those items for a later session; when it says they are at one, such as `at my PC`, ask those first.
For an action only the user can take, give the exact steps and the check you will run once they report it done; take any secret through the host's secret prompt.

Settle a draft's items with its PR, naming cleared ones in its `/quest-iterate` brief.
Remove a quest's cleared item, or its answered one after recording the answer and reason in its Plan as `Decided <date> (maintainer, /quest-run): ...`; delete a quest whose only purpose was that wait, recording why and any answer in the PR body's `## Decisions`.
Make these edits in one draft PR on a `quest-run/<slug>` branch, run `quest check` on the edited tree, then dispatch `/quest-review` on it; it is then in scope like any PR.

## Loop

Each round, rerun `quest unblocked --unclaimed --json` and refresh the open PRs, since merges and released claims make more work ready.
When no agent is running and every question has been asked, block with `quest wait` on the queued PRs whose merge would make a quest ready, and on each PR ready for review whose checks are still running and which a round would then pick or ask about; run a round once one lands or leaves the queue, or its checks pass or fail.
Wait on no other PR, such as a draft or a skipped one, and read none between rounds: list each PR left for a later round in the summary, with its pick.
A usage or rate limit is waited out until its reset; it never ends the run.

Finish once nothing is running, no queued merge would make a quest ready, no PR waited on above still has checks running, every PR left needs the user or a later round, and every wait in scope is decided, skipped, or left to an outside party.
Then plan the run's follow-ups as `quest context` describes, such as a blocker agents hit, including those kept in each of this run's own merge picks for another repository's quest tree, landed or not, unless the user withdrew the pick.
Write the final summary, naming those plan PRs and listing the waits settled, cleared, or deleted and each still held with who acts and its check's result, so a fresh session can act on it, with each open decision's options beside your recommendation.

Besides the guide's controls, answer "decisions": ask every pending question now, in one batch, such as before the user steps away; the loop continues after.
On "finish up", still run `/quest-merge` when a picked PR's sub-agent reports, but dispatch nothing it hands back and plan nothing, and list each pick left standing and each follow-up left to plan.
