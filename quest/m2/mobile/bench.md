# [M] Quest bench page

## Goal

The [Worker](/quest/m2/mobile/worker.md) shows, per repository, how quests
performed: for each quest PR merged in the last 30 days, its size,
implementers, review score and rounds, time from claim to merge, and CI
wall time, with rollups by size and implementing model and the latest
`quest eval run` scores. It shows which sizes and models land cleanly and
where review rounds or CI time pile up.

## Plan

- Read only records that already exist: each PR body's `## Models` and
  `## Review` sections, parsed with the CLI's own parser
  (`src/core/record.ts`) rather than a copy, and check-run timings from
  GitHub. Token cost stays out: it lives in host transcripts, and the
  benchmark epic keeps private cost out of public repositories.
- Once the benchmark epic's
  [records endpoint](/quest/m0/benchmark/records-endpoint.md) serves
  records, read from it instead and delete the PR-body parsing.
- Compute rollups at request time with a fixed read budget, cached with
  the Cache API, and say when the window was cut short.
- Cross-check a sample of rows against `quest status <pr>` and the PR
  pages, and benchmark the page on
  [device bench](/quest/m2/mobile/devices.md).

## Required

- [Quest board](/quest/m2/mobile/board.md) - the repository pages this
  adds a bench page to
- [Device bench](/quest/m2/mobile/devices.md) - validation on the
  physical Android phone and iPad
