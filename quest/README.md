# Quests

## Goal

Make Quest the public binary through which any repository and user plan and
coordinate work through versioned Markdown, posting every session's
telemetry to kixel.quest.

Non-goals: storage, dashboards, and the merge queue, which
kixel-ai/kixel.quest owns; repository- or user-level model settings.

## Plan

Decided 2026-11-23 (maintainer, `/quest-run`): "please stop doing evals",
"we don't want to waste tokens on throw-away reviews/code". ✅ Delete
`quest eval` and every quest step that runs it (rejected: keep the command
and drop only the quests' eval steps; drop only `AGENTS.md`'s eval rule).
Reviewer routing is judged from real PRs instead: `quest usage`'s per-reviewer
findings, share fixed, and cost, and the `## Caused by` escapes it lists
against each culprit's reviewers.

Decided 2026-11-22 (maintainer, `/quest-plan` in
[kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104)),
reversing both decisions below on where tooling lives: ✅ "`quest` is public.
… quest is the public binary that contributors and maintainers run that
posts metrics to kixel.quest, which is a public website and dashboard. We're
focusing on metrics first but the idea is to move spawning/workers/etc to
kixel.quest eventually" (rejected: a `kixel-quest` binary; a generic Quest
with no kixel.quest references). `records`, `eval`, `agent`, `worktree`,
`gate`, and model routing stay here, and [telemetry](/quest/m0/telemetry/README.md)
plans the posts. ✅ "Leave quest public and don't make it too extensible.
Like we should just ship the allowed models per effort level; don't fuck
around with letting repos configure any special settings": Quest ships one
order of models and efforts per quest size and nobody configures it. Claude,
Codex, then Gemini write; Codex, Gemini, then Claude review; "T-shirt size
determines model/effort, while risk determines number of reviewers"
(rejected: a user ranking within shipped lists, which deletes
`quest/m1/model-config.md`; lists per reasoning effort; Claude-only
writers). Amended 2026-11-23 (maintainer, `/quest-run` on
[kixel-ai/quest#831](https://github.com/kixel-ai/quest/pull/831#issuecomment-7111249892)):
reviewers draw from cross-vendor rungs each round instead of a fixed order.
Superseded 2026-11-25 (maintainer, on the audit of 2026-11-24's sessions,
which spent 62% on review and its rework): the risk tier seats no reviewer
when low, Sol when medium, and Sol and Opus when high, each at its size's
effort; Opus writes every size above XS, S's Sonnet arm aside while the
writer A/B runs; and no rung, shadow, or vendor
quorum runs. A high head waits for both: while either cannot run, its round
fails as an outage (rejected: review with the one left).
Narrowed 2026-11-25 (maintainer, closing
[kixel-ai/quest#898](https://github.com/kixel-ai/quest/pull/898) and
[kixel-ai/quest#891](https://github.com/kixel-ai/quest/pull/891)): ✅ "keep it
simple. Claude writes, codex+claude reviews" (rejected: Codex, then Gemini, as
fallback writers; Gemini as an opt-in reviewer). Quest runs no Antigravity.

Decided 2026-11-21 (maintainer, `/quest-plan` in
[kixel-ai/kixel.quest#85](https://github.com/kixel-ai/kixel.quest/pull/85)),
reversing the 2026-11-13 decision below: kixel-ai/quest stays a clean,
generic public tool, keeping the quest-tree contract, the GitHub PR
workflow, a forge read client at a configurable URL, and harness-agnostic
skills with no kixel.quest references (rejected: GitHub-only with no
configurable forge URL; stripping the GitHub PR commands). `records`,
breakage, `eval`, risk tiers and guardrails, `agent`, `worktree`, `gate`,
model routing, and `land` move to kixel.quest, and review pairing, model
rankings, and local hooks to dotfiles.

Amended 2026-11-22 (maintainer, in the session that planned
[kixel-ai/quest#826](https://github.com/kixel-ai/quest/pull/826)): model
routing splits rather than moving out. ✅ For each quest size, Quest lists
the writer and reviewer models it accepts, each at a minimum effort, and
the user's config ranks and picks among them, Quest refusing a model off
the list (rejected: lists per reasoning effort, with sizes mapped in
config, which lets a weak model take an XL quest; moving routing out
entirely). The size tables in `src/cli/models.ts` and the writer A/B arms
become the maintainer's config.

Decided 2026-11-13 (user, /quest-plan, unprompted, while planning
[the benchmark](/quest/m0/benchmark/README.md)): "I'm fine dropping quest
as a generic solution for now. The binary needs to runnable by
contributors, but it's a non-goal to have them use their own (non-fork)
repos". The Goal read "a reusable way to plan and coordinate repository
work... with a reversible adoption path" until then. m1's public-release
quests predate this, so [this tree's first `tree` audit](/quest/m1/audit-tree.md)
checks them first.

`m0` is adoption on moq-dev's and kixel-ai's own repositories, `m1` the public release,
and `m2` later work. Add later horizons when concrete work warrants them,
keeping milestone numbers stable as earlier milestones complete.
