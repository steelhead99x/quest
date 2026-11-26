# [M] Quest review posts its rounds instead of writing the Review section

## Goal

`quest review` posts each round to Kixel Quest: head, base, seat (harness, model, effort, second seat), session, the risk tier with its reason and classifier, and each finding with file, lines, and severity, plus each finding's outcome as `--responses` settles it.
A head that gets no local reviewer posts its classification alone.
A post gates a merge only when its poster has write access, so a contributor's own rounds are recorded but a maintainer's review still decides.
It no longer writes the PR body's `## Review` section, and `quest status`, `quest merge`, and readiness read the review from Kixel Quest.

## Plan

Decided in the [epic](/quest/m0/telemetry/README.md): ✅ `## Review` moves out of the body.

- Post each round as it is written, from the full round in hand; a failed post fails the run. A saved session under `.git/quest/review/` keeps only its last round in full, its earlier rounds just their head, merge base, and findings, so a run never posts a round afterward from the saved state, which needs no change; only [backfill](/quest/m0/telemetry/backfill.md) does, sending each saved session's last round, which carries its score and rationale.
- Each round also posts its round number, 0 to 10 score, and the score's rationale, so Kixel Quest shows every round's score in order rather than only the latest one the body keeps; decided 2026-11-24 (maintainer, `/quest-plan` in [kixel-ai/kixel.quest#146](https://github.com/kixel-ai/kixel.quest/pull/146)). Test that two rounds of one session each post their own round number, score, and rationale.
- Kixel Quest's server side is deployed: `POST /reviews` takes a bearer record token and `{runs, outcomes}`, the shape `parseReviews` in kixel.quest's `src/schema.ts` defines, which moves to `quest/core` with this quest's posting ([kixel-ai/kixel.quest#183](https://github.com/kixel-ai/kixel.quest/pull/183), Decision 1). Its lookup still falls back to the body record until kixel.quest's `review-body-read` quest drops that read.
- Update the guide, `assets/CONTEXT.md`, and the review, iterate, and merge skills where they describe the `## Review` record; this decision is the maintainer's request for that work.

Tests: a round posts each finding with its location; a `--responses` round posts each finding's outcome; a low head posts its classification alone; and the PR body is left unchanged.

## Required

- [Login](/quest/m0/telemetry/login.md) - the token each post carries
