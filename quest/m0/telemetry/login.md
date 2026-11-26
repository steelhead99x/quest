# [M] Quest login signs a machine in to Kixel Quest

## Goal

`quest login` shows a code, the person approves it at kixel.quest, and the machine holds a posting token named after its host; it also asks once whether to upload transcripts.
Every command that posts or reads Kixel Quest (the record sender, `quest review`, forge reads) uses that token, and fails with "run `quest login`" when there is none.
`quest logout` removes it.

## Plan

Decided in the [epic](/quest/m0/telemetry/README.md): ✅ sign-in required, no local fallback.

- It replaces hand-pasting a token from kixel.quest's Tokens page into `~/.config/quest/records.json`; read an existing file once and move it, rather than supporting both.
- The transcript question says plainly that transcripts can hold pasted secrets and file contents, and that the repository's maintainers can read them.

Tests: against a local Worker, an approved code stores a token that the sender uses; a command needing Kixel Quest without a token fails naming `quest login`; and `quest logout` removes the token.

## Waiting

- kixel-ai/kixel.quest: its [sign-in](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/sign-in.md) quest serves the device-code approval. Check that its file is gone from that repository's tree.
