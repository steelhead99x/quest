# [S] Cut the context a quest-start session re-sends

## Goal

A `/quest-start` session costs less per merged PR, because it carries less context through its later requests, with no loss in review quality or in what the PR validates. `quest usage` over a week of sessions shows the cut against the baseline below; no fixed target is set.

Non-goals: the writer's model and effort (owned by [Routing evidence](/quest/m0/routing-evidence/README.md)), and trimming the always-loaded rules and skills ([kixel-ai/quest#807](https://github.com/kixel-ai/quest/pull/807)), which the baseline shows is not where start sessions spend.

## Plan

Decided 2026-11-22 (maintainer, `/quest-run`, on [kixel-ai/quest#803](https://github.com/kixel-ai/quest/pull/803)'s closing re-measure of the token waste epic): keep a follow-up on `quest-start` spend (rejected: close the epic with no follow-up). The auto-compact window question went to kixel-ai/dotfiles' quest tree, holding at 400k until this quest's cut is measured.

What remains is the re-measure: [kixel-ai/quest#808](https://github.com/kixel-ai/quest/pull/808) added one line to `assets/skills/start.md` asking for the reads a step already knows it needs in one response. Re-measure a week of start sessions after it lands, as below, and then keep, reword, or drop that line; if it moves the batching share, propose the same line for `assets/skills/iterate.md` (17.8% of the host's Claude spend in the baseline window).

Baseline, 2026-11-14 to 11-21, this host, from `token-max sessions` and the sessions' transcripts (a session counts as `quest-start` when it, or the session that spawned it, ran `/quest-start` first; a request is one API response, deduplicated by message id; dollars are API list prices, 1h cache writes at 2x input):

- 324 sessions (196 main, 128 sub-agents) cost $2.5k of the host's $5.3k Claude spend, 47%; $1.85 per merged PR across the 7 repositories, and $1.32 for `quest usage --since 2026-11-14`'s `implementing` role on kixel-ai/quest's 68 merged PRs.
- Cost by part: cache writes 26%, output 21%, re-sent tool results 17%, re-sent assistant turns (mostly retained thinking and tool-call inputs) 26%, the first request's prompt re-sent 9%. Phase: 72% before the first push, 12% between push and `quest review`, 16% from review on.
- Requests: 42,808, of which 6.7% make more than one tool call, and 51% (52% of cost) make a single read-only call (`Read`, `Grep`, `Glob`, or a shell `sed`, `cat`, `grep`, `rg`, `ls`, `git show`/`log`/`diff`, `gh ... view`), mostly in runs of three or more. Of consecutive single-read pairs, 24% read files that neither the first call nor its result named, so were likely independent; their requests' cache reads alone cost $99.
- Re-sent tool results, counted only until the session's next compaction: $441. No outliers: the 20 largest are 1.6% of it, the largest 1,000 are 29%. Shell reads are 45% (`sed` 35%, `cat` 10%), `grep` 15%, `quest skill` and `quest context` loads 9%, `quest gate` output about 1%. Reads are mostly bounded already: two thirds of read cost is ranged reads, results over 6k tokens are $21, re-reads of a range already read are $20, and 3% of single reads page the file the previous request read.

Verify with, next to the figures above: the share of start-session requests making more than one tool call and the share making a single read-only call; cost per merged PR from `quest usage --since <date>`'s `implementing` role on kixel-ai/quest and host-wide from `token-max sessions`; and review findings per PR, so a cheaper session that finds less is visible.

Agent's choices, for review:

- No source cut in `quest`'s own output: gate, review, and status output is about 1% of re-sent tool results, and the skill and context loads are what trim-skills sized.
- No `PreToolUse` check denying unbounded `cat` or `sed`: whole-file and over-6k reads are too small a share to be worth a hook that blocks legitimate reads of small files.

## Scheduled

- 2026-11-30 - a week of start sessions after the skill line lands

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - the writer A/B that tunes the model and effort behind most of this cost
