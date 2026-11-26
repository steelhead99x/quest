# [M] Records carry the routing decision, replacing Implementer lines

## Goal

Each session record names the quest size and role it was routed for, the entry `quest` picked (harness, model, effort, A/B arm), each entry it fell through and why (CLI missing, logged out, usage limit), the PR it works toward from its first request, and the machine it ran on.
The sender also posts a heartbeat each hour with the count of sessions it saw end, so Kixel Quest can flag a host that stopped sending, which a missing record alone cannot show.
The skills stop writing `Implementer:` lines, and whatever read them (iterating on the writer's model, keeping a reviewer no weaker than the writer's model, an arm's iterates) reads the writer from Kixel Quest instead.
The sender stops parsing `## Caused by` on the host, since Kixel Quest parses it from the indexed body, and its queue refuses a fix that names no finder or a `reviewer` without a name. The guide's format in `assets/CONTEXT.md` therefore names the reviewer, as `found by reviewer Pullfrog`, with no parenthesis of its own inside the line's; land that wording before Kixel Quest's [finder](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/finder.md) refuses on it.
`quest usage` still reads these lines through `culprits()` in `src/cli/breakage.ts`, which today takes only the bare finder: it keeps the reviewer's name, with and without an incident after it.

## Plan

Decided in the [epic](/quest/m0/telemetry/README.md): ✅ `Implementer:` lines become posts. 68% of them said effort `unknown` in [kixel-ai/quest#826](https://github.com/kixel-ai/quest/pull/826)'s audit, while transcripts record the effort.

- `quest agent` knows the routing decision; write it where the record sender finds it for that session.
- `## Models` keeps its `Size:` line, which starting and reviewing need.
- Update the guide (`assets/AGENTS.md`'s iterate routing), `assets/CONTEXT.md`'s `## Models` rule, and the run, iterate, and review skills; this decision is the maintainer's request for that work.

Tests: the sender's hourly heartbeat counts the sessions that ended; `culprits()` reads `(found by reviewer Pullfrog)` and `(found by reviewer Pullfrog; incident 123)` as a reviewer finder with its name, and still reads `(found by customer; incident 123)`; a session that fell from one writer to the next at a usage limit records both and the reason; an iterate routes to the writer Kixel Quest reports; and no skill writes an `Implementer:` line.

## Waiting

- kixel-ai/kixel.quest: its [sessions](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/sessions.md) and [finder](https://github.com/kixel-ai/kixel.quest/blob/main/quest/m0/insight/finder.md) quests are deployed. Check that both files are gone from that repository's tree.

## Required

- [Login](/quest/m0/telemetry/login.md) - the token that names a record's host
