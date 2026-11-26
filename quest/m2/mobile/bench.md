# [S] Bench page from stored records

## Goal

The bench page (`cloudflare/src/bench/`) reads merged quest PRs' records
from the benchmark epic's records store instead of parsing PR bodies, and
shows each repository's latest `quest eval run` scores beside its review
rollups.

## Plan

- The page today parses each merged PR's `## Models` and `## Review`
  sections with the CLI's own readers (`src/cli/models-record.ts` and
  `parseReview` in `src/core/review.ts`), reads the head commit's check
  runs for CI wall time, and says on the page that eval scores are not
  shown.
- Once the records endpoint serves records, read the same rows from it,
  delete the PR-body parsing in `cloudflare/src/bench/load.ts`, and keep
  token cost off public repositories' pages, as the benchmark epic keeps
  private cost out of them.
- `quest eval run` prints its scores and puts them in its PR's
  `## Validation` prose; nothing stores them. Have the records endpoint
  keep the latest run per repository, or plan where it should live, before
  this page shows them.

## Required

- [Records endpoint](/quest/m0/benchmark/records-endpoint.md) - the store
  the page reads instead of PR bodies
