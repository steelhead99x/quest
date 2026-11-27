# [M] Advisor trial readout

## Goal

Read out the writer A/B's advisor trial, cohort `advisor-2026-11`, which
[kixel-ai/quest#934](https://github.com/kixel-ai/quest/pull/934) started at
every size: arm A runs the size's own writer, and arm B pairs a writer with
Claude Code's advisor tool (Sonnet high advised by Opus at XS, S, and M; Opus
advised by Fable at L and XL). Put a recommendation for each size's writer to
the maintainer as a decision, with its tally and cost, and end the trial's arms
once each size is decided.

Non-goal: the legacy XS and S arms, which stopped drawing when the trial
started; the [Routing evidence](/quest/m0/routing-evidence/README.md) epic's
2026-12-01 readout owns them.

## Plan

The implementer's choices, for the readout to revisit:

- Read only the `arms` rows of `quest usage --json` whose `cohort` is
  `advisor-2026-11`; every armed `Implementer:` line names it, as
  `(arm B, cohort advisor-2026-11, advisor claude-opus-5-5)`, and the legacy
  rows report under cohort `null`. A PR counts only when every line names the
  same arm, cohort, writer, and advisor, so an iterate off its arm leaves it out.
  Also leave out a PR whose first line names an arm but not that arm's current
  entry, mostly quests resized after the arm was drawn.
- Decide as the legacy arms are decided: compute each size's variance and the
  PRs each arm needs to detect 0.25 first-round findings per PR, and if the
  arms have not reached it, rewrite the `Scheduled` date for when they will.
  Report XL's counts rather than wait for a detectable difference. Report
  Routing evidence's cost metric beside the findings: the mean spend per merged PR,
  including later `## Caused by` fixes, with a bootstrap interval.
- Price the advisor's spend. token-max reports an advisor iteration's tokens
  under the advisor's model, but Claude Code 2.1.330 records no service tier
  on it, so token-max leaves its cost at $0 with `complete` false, which
  flatters arm B; a kixel-ai/token-max follow-up of
  [kixel-ai/quest#934](https://github.com/kixel-ai/quest/pull/934) asks it to
  price them. If it still does not at the readout, price each arm-B session's advisor-model tokens at that
  model's list price yourself from `quest usage --json`. Transcripts outlive the trial: the maintainer's
  host keeps them for 3,650 days (`cleanupPeriodDays`), and the session
  records sent to Kixel Quest keep each model's token counts too.
- End each decided size's arms by deleting its `ARMS` entry from
  `src/cli/models.ts`. Once none is left, delete `ARMS` and `COHORT`, as well as
  `quest models --arm` and `--cohort`, and the `arm` and `cohort` fields of
  `quest unblocked --json`. Also delete the arm notes in the README, guide, and
  `/quest-run` and `/quest-iterate`. Keep `quest agent --advisor` only if a
  writer table then names an advisor.

## Scheduled

- 2026-12-04 - one week after the trial started, the first sample check

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - the legacy writer
  A/B's readout and the cost metric this reuses
- [Model check](/quest/m1/model-check.md) - carries the tallies into its baseline
