# [M] Add Neon as third reviewer on rungs 5 and 6

## Goal

Add `gemini-4-neon` via `agy` as a third gating reviewer (`seat: "third"`) on
rungs `5` (`L high`, `XL med`: `Neon medium`) and `6` (`XL high`: `Neon high`)
of the `(size + risk)` reviewer ladder, reusing [Stuck-agent advisor](/quest/m0/advise.md)'s
read-only `agy` runner and failing loud as an outage when `agy` cannot run.

Non-goals: using `agy` or Neon for writers, risk classification, or rungs
`0`–`4`; degrading silently to 2 seats when `agy` is unavailable.

## Plan

Decided 2026-11-27 (maintainer, `/quest-plan`):

- Goal? ✅ Add Neon via `agy` as the 3rd reviewer on rungs `5` (`Neon medium`)
  and `6` (`Neon high`) of the pure 7-rung `(size + risk)` ladder (rejected:
  2 reviewers max without Neon; Neon only on `high` so `XL med` stays 2 seats).
- Outage behavior when `agy` is missing, logged out, at its limit, or
  unsupported on the host (such as macOS's default case-insensitive
  filesystem)? ✅ Fail as an outage, matching how multi-seat rungs fail when
  Sol or Opus cannot run; `--harness` still lets a person override manually
  (rejected: degrade to 2 seats with a warning; fall through to Fable or Astra).

The maintainer authorized the edits this needs in `assets/skills/review.md`,
`assets/skills/merge.md`, `assets/skills/run.md`, and `README.md`.

Recommended, for the implementer to confirm:

- `src/core/reviews.ts`: `"third"` is already in `SEATS` without sending any
  `"third"` rounds yet, and this quest's `## Waiting` item confirms
  `kixel.quest` has pinned and deployed that `quest/core` release before clients
  begin posting `seat: "third"`.
- `src/cli/models.ts`: add `agy("gemini-4-neon", "medium")` to rung `5` and
  `agy("gemini-4-neon", "high")` to rung `6` in `REVIEW_RUNGS`.
- `src/cli/review.ts` & `src/cli/agent.ts`:
  - Reuse the read-only `agy` turn runner, deny rules, limit parsing,
    case-insensitive volume refusal, and persisted API-list pricing restored by
    [Stuck-agent advisor](/quest/m0/advise.md) (instead of duplicating harness
    plumbing).
  - Generalize `SeatId` / `Session` / `Tally` / `Round` from `second?: true` to
    `seat: "pick" | "second" | "third"` (or keep `pick` default + explicit seat
    tag) so findings number cleanly across all 3 seats, all 3 seats run in
    parallel under `runSeats`, `--accept` requires every seat on the rung, and
    any open findings on `third` are settled even if a later head drops below
    rung `5`.
  - When `agy` cannot run (missing CLI, logged out, usage limit, or unsupported
    case-insensitive filesystem), fail the run as a `ReviewOutageError` naming
    the reason rather than dropping the 3rd seat.
- `src/cli/usage.ts`: surface `third`-seat tallies and `agy` API-list spend
  alongside `pick` and `second`.

Tests: unit tests for 3-seat scheduling on rungs `5` and `6`, finding numbering
and settlement across 3 seats, outage failure when `agy` is unavailable or on a
case-insensitive filesystem, `--accept` requiring all 3 seats on rungs `5`–`6`,
`parseReviews` accepting `seat: "third"`, and `just review-sandbox` covering
`agy`'s read-only review invocation.

## Required

- [Stuck-agent advisor](/quest/m0/advise.md) - restores the read-only `agy`
  runner, deny rules, limit parsing, and API-list pricing

## Waiting

- kixel-ai/kixel.quest: `POST /reviews` accepts `seat: "third"` (via a bumped
  `quest/core` pin) and displays third-seat rounds in merge cards and factory
  pages. Check that `kixel-ai/kixel.quest` imports a `quest/core` version whose
  `SEATS` includes `"third"` and has deployed it.

## Related

- [Routing evidence](/quest/m0/routing-evidence/README.md) - tracks per-rung
  findings, fix rate, spend, and escapes
