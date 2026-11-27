---
description: Keep this session's work going while the user is away, taking your recommendations and deferring merge picks until they return. Use when the user says afk, afk merge, or afk soon.
guide: Summaries
---

The user has stepped away and will not answer; a message of just `afk`, or `afk` and a mode below, runs this skill.
Keep this session's work going within its scope: the skill it is running, such as `/quest-run`, or else the task at hand. In a session with no work under way, run `/quest-run`.
Ask nothing: wherever you or an agent would ask the user, take your recommendation instead, unless the decision is deferred below.
A deferred question counts as asked, so a skill's loop goes on past it and finishes as that skill describes.

The argument picks a mode, and modes combine, such as `soon merge`:

- None: every merge pick below waits for the user.
- `merge`: also run `/quest-merge` on each PR you strongly recommend merging that `quest status` shows low or medium for its head, with a review that counts for that head, no open decision, no follow-ups, and no quest deleted or deprioritized beyond the one it finishes. Defer every other PR, a high or unclassified one included.
- `soon`: the user is about to leave. Ask every question the session has pending now, in one batch, as `/quest-run`'s "decisions" does, and act on the answers; once the prompt returns, go on as afk, taking or deferring each question it left unanswered as below.

Other words widen what you may decide, such as "close superseded PRs"; act on them within their words. A grant of merges that names no risk tier is `merge`.

Take every decision a later PR review can still undo:

- On a quest or PR this session works on itself, take your recommendation on each decision, list those choices in the PR body for review, and run `/quest-review` when nothing else remains.
- Tell each agent you dispatch that the user is away, so it does the same.
- As a coordinator, dispatch `/quest-iterate` on a PR with open decisions, with your recommended answers in its brief.

Unless the mode or argument allows it, defer as blockers what no review can undo and what only the user can do:

- Merge picks beyond a standing `/quest-merge` pick, deleting or deprioritizing a quest, closing a PR, and taking over a stale claim or hold.
- A follow-up's decisions, which wait for its PR's pick.
- `/quest-plan` sessions, and actions only the user can take, such as granting access or providing a secret.

Carry on each pick the user already made until it lands or needs them again.
When the work finishes, end with a final summary holding only the blockers, each linked, with its options and your recommendation, so a fresh session can act on it; list the `Maintainer (PC):` steps, which need the user at a computer, apart from the rest. The choices you took live in the PRs' bodies.

A message that adds to these instructions, such as a newly granted merge or more work, amends them, and afk continues.
Any other message is the user's return: afk ends. Answer it, then resume the session's skill, or `/quest-run` on the blockers when it ran none, which asks the questions it deferred.
