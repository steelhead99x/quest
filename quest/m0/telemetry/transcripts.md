# [S] The sender uploads transcripts for people who opted in

## Goal

For a person who said yes at `quest login`, the record sender uploads each session's transcript, sub-agents included, gzipped, with its record.
Turning it off stops uploads.

## Plan

Decided in [kixel-ai/kixel.quest#104](https://github.com/kixel-ai/kixel.quest/pull/104): ✅ opt-in per person, readable by the sender and the repository's maintainers (rejected: the sender only; asked per session).

`quest login` records the person's answer as `transcripts` beside the host's token (`Login` in `src/cli/tokens.ts`), which nothing reads yet; signing in again and answering no turns uploads off.

Tests: an opted-in session's transcript is uploaded once; an opted-out one is not.

## Waiting

- kixel-ai/kixel.quest: its [transcripts](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/transcripts.md) quest stores uploads. Check that the file is gone from that repository's tree.
