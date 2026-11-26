# [S] The sender uploads transcripts for people who opted in

## Goal

For a person who said yes at `quest login`, the record sender uploads each session's transcript, sub-agents included, gzipped, with its record.
Turning it off stops uploads.

## Plan

Decided in [kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104): ✅ opt-in per person, readable by the sender and the repository's maintainers (rejected: the sender only; asked per session).

Tests: an opted-in session's transcript is uploaded once; an opted-out one is not.

## Waiting

- kixel-ai/kixel.quest: its [transcripts](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/transcripts.md) quest stores uploads. Check that the file is gone from that repository's tree.

## Required

- [Login](/quest/m0/telemetry/login.md) - where the person opts in
