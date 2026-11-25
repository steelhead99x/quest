# [M] Quest bench data for the mobile apps

## Goal

The [quest feed](/quest/m2/mobile/feed.md) gains a bench section: for each
quest PR merged in the last 30 days, its size, implementers, review score
and rounds, time from claim to merge, and CI wall time, plus rollups by
size and implementing model and the latest `quest eval run` scores. Both
apps' bench screens show it: which sizes and models land cleanly, and
where review rounds or CI time pile up.

## Plan

- Read only records that already exist: each PR body's `## Models` and
  `## Review` sections, parsed with the CLI's own record parser
  (`src/core/record.ts`) rather than a copy, and check-run timings from
  the GitHub API. Token cost stays out, since it lives in host
  transcripts and the benchmark epic keeps private cost out of public
  repositories.
- Once the benchmark epic's [records endpoint](/quest/m0/benchmark/records-endpoint.md)
  serves records, read from it instead and delete the PR-body parsing.
- Cross-check a sample of rows against `quest status <pr>` and the PR
  pages before review.

## Required

- [Quest feed](/quest/m2/mobile/feed.md) - the document and workflow this
  extends
