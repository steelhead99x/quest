# [M] Development as a benchmark

## Goal

Software development in moq-dev's and Kixel's repositories is run as a
benchmark with several axes. Every change records its risk tier, what it
cost (tokens, compute, and time split into working and blocked on CI,
GitHub, git, or a person), who wrote and reviewed it, and what it later
broke. The tier, set from the change itself, scales its guardrails: review
depth and human approval, never CI. The maintainer
steers from a report of all of it without reading code, and adds or removes
guardrails from that evidence. Every cost is measured so it can be driven
toward zero.

This epic's own work is the end-to-end check: one real PR, taken from its
first session to a week after its merge, shows on Kixel Quest's
[factory page](https://kixel.quest/factory) with its tier and reason, its cost on every axis, its reviews, and
anything it broke, and the numbers match what `quest usage` prints for it.

Non-goals: storing records in PR bodies or git; a dashboard in `quest`
itself, which Kixel Code owns; deploy safety, which each repository's own
tree owns.

## Plan

Decided 2026-11-13 (user, /quest-plan, from
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)
and the posts it links, a survey of the four quest trees, and the
maintainer's typed messages since 2026-10-01):

- Goal?
  - ✅ Measurement and risk tiers together, measurement covering everything
    including blocked time
  - Rejected: measurement only, with tiers planned from its data later;
    tiers only, on today's `quest usage`
- How do low-risk PRs land, given Kixel Code had settled that every code
  merge is a tap?
  - ✅ Earned from evidence: tiers start by only recording, automatic
    merging starts with what the standing pick covers today, and each
    wider class of change is the maintainer's decision off the report.
    Reverses Kixel Code's rule.
  - Rejected: every low-tier PR merges on its own from day one; every merge
    stays a tap
- Where does the report reach the maintainer, given Kixel Code had settled
  that decisions are pulled, never pushed?
  - ✅ A factory page in Kixel Code plus a pushed digest. Reverses the
    rejected digest.
  - Rejected: the page alone; `quest usage` alone
- Which repositories get quests? ✅ kixel-ai/quest, Kixel Code,
  moq-dev/moq, and moq-dev/moq.pro (rejected: the first two, with the
  others as a follow-up; those plus moq-dev/moq.pro).
- Must Quest stay generic? ✅ No (user, unprompted): contributors must be
  able to run the binary, and using it on repositories of their own that
  are not forks is a non-goal. The root Goal and `AGENTS.md` say so since
  this plan (rejected: recording it only in these quests; also auditing
  m1's public-release quests in the same session, left to `/quest-audit`).
- Where do records live? ✅ Kixel Code stores them, and the PR body keeps
  only its short lines (rejected: a data branch in each repository, which
  puts private cost in public repositories; rebuilding from each host's
  transcripts on demand, which is slow and lost when transcripts are
  pruned).
- How is time classified? ✅ Exact where a tool already times the wait, a
  cheap model for the rest of the transcript (rejected: the model alone;
  tool timings alone).
- Who sets the risk tier? ✅ The diff (user: "effort is for writing the
  code, and risk is for merging it"). Size keeps routing the writer.
  Rejected: set at planning and re-judged from the diff; a separate score
  per axis.
- What does the tier scale?
  - ✅ Review and approval only (maintainer, 2026-11-22, reversing
    [kixel-ai/quest#802](https://github.com/kixel-ai/quest/pull/802)'s full
    suite for high: "we're so CPU starved that we shouldn't waste it on more
    CI unless it actually catches issues. Running the full suite is dumb
    because the next commit (or nightly) can catch the issue anyway. We
    should use RISK to get additional/stronger reviews instead."): a high
    PR gets two reviewers from different vendors
  - Rejected: review, approval, and CI; approval only
- Must a PR state how to undo it? ✅ No (maintainer, 2026-11-22: "I
  definitely don't want Undo to be a gate"). Rejected: an `## Undo`
  section that `quest merge` requires of every PR not tiered low.
- Who moves a class of change into or out of automatic merging?
  - ✅ The maintainer, both ways: the report flags a class whose breakage
    rose, and it keeps merging until they act
  - Rejected: a breaker that tightens on its own; automatic both ways
- Digest? ✅ Daily, with breakage posted at once (rejected: weekly;
  breakage only).
- Milestone? ✅ m0 here and for Kixel Code's store and page; m1 for Kixel
  Code's digest and for moq-dev/moq's and moq-dev/moq.pro's quests
  (rejected: everything in m0; everything in m1).

What the posts add that these quests take: a tier set from the change and
not its author, paths that always need a person, evidence and a brief
read in place of the diff, automatic merging widened one class at a time
on breakage data, and past incidents kept as a reviewer's test set.
Already in place: a different model reviews each PR, every finding is
answered before merge, a design checkpoint after repeated review rounds,
a merge queue, and diff-scoped gates in moq-dev/moq and moq-dev/moq.pro.

No post describes attributing cost, model, and effort to each change, so
that part has no precedent to copy.

### Check of 2026-11-25

Run on [kixel-ai/quest#899](https://github.com/kixel-ai/quest/pull/899),
which has the evidence. No PR could pass yet: the factory's oldest merge
is 2026-11-23 04:40 UTC, and the hosts' record senders first sent between
2026-11-23 04:47 and 21:44 UTC, so no PR with every session recorded is a
week past its merge. The earliest such quest PR found is
[#850](https://github.com/kixel-ai/quest/pull/850), merged 2026-11-24 03:02
UTC, whose sessions all ran on one host after its sender started; check
it, or an earlier one whose sessions all reached Kixel Quest. Run `quest
usage --pr <n>` with `--ssh` for every host that ran its sessions.

Per axis, on #819, #832, #849, #850, #871, and #887:

- Tier and reason: shown, and identical to `quest usage`.
- Cost: the factory shows one price per PR, and of the other axes only
  sessions, once; every other axis's drill-down
  (`/factory/pulls?set=axis:<axis>`) fails with "Something went wrong".
  Prices disagree: #850 $50.73 on the factory against ~$76.51 in `quest
  usage`, and #832, #849, and #871 $0.00 against ~$4.24, ~$0.82, and
  ~$0.54. `quest usage` splits time and reads waits only on its own host,
  so a remote session's time can't be matched.
- Reviews: the factory names a PR's reviewers only when the PR broke
  something, and never its rounds, scores, or findings.
- Breakage: the factory flags a PR whose merge commit's push run went
  red, as "found by a check, 2s after it merged". #871 changed only
  `assets/CONTEXT.md` and is flagged for a test run killed mid-suite
  (run 45521382739); `quest usage` counts only `## Caused by` lines and
  reports nothing for it.

## Scheduled

- 2026-12-02 - the first day, in any timezone, that a PR whose every session reached Kixel Quest, such as #850 (merged 2026-11-24 03:02 UTC), is a full week past its merge

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - measures what
  each writer and reviewer effort buys; its tallies become records here
- [Model check](/quest/m1/model-check.md) - retunes routing each milestone
  from the same records
