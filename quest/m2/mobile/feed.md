# [M] Quest feed

## Goal

A workflow publishes one versioned JSON document describing the default
branch's quest tree, which both mobile apps read instead of the Markdown.
It holds the tree's counts by milestone, size, and state (ready, blocked,
waiting, claimed), the ranked `quest unblocked --json` list, the
`quest waiting --json` items, each quest's title, size, path, and branch,
and the commit and time it was built from. A schema in `docs/` documents
every field and its version.

## Plan

- Build it from the CLI's existing `--json` output in a workflow on pushes
  to the default branch and on a daily schedule, so claims and drafts
  refresh between pushes. Add no `quest` subcommand: if a field cannot be
  derived from today's output, raise that as a decision in the PR rather
  than growing the CLI.
- Recommended host: GitHub Pages, served as plain JSON with an ETag so the
  apps can poll cheaply without auth. The publishing job gets its write
  permissions only in a protected-branch environment, so pull request CI
  stays read-only. Rejected: an Actions artifact, which needs auth and
  arrives as a zip that iOS's Foundation cannot open without a dependency;
  committing the JSON to a branch, which churns history.
- The feed carries a `schema` integer. The apps refuse a version they do
  not know and show which app version they need, rather than guessing.
- Bound the document: titles truncated, list lengths capped by design, and
  the total size checked in the workflow, so a hostile tree cannot make a
  phone hold an unbounded payload.
- Validate it in the workflow against the schema, and diff the counts
  against `quest check` and `quest unblocked` run independently.
