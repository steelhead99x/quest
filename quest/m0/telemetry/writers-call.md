# [XS] quest/core names Kixel Quest's writers read

## Goal

`quest/core`'s forge calls name `writers`, the read Kixel Quest already serves at `POST /forge/writers`, with its request and answer parsers, so Kixel Quest parses it as it does every other forge read and `quest` can read who wrote a PR.
The PR sends nothing; reading writers in place of `Implementer:` lines is [Implementer cutover](/quest/m0/telemetry/implementer-cutover.md)'s work.

## Plan

Found 2026-11-27: kixel-ai/kixel.quest's writer read (`quest/m0/insight/writer-read.md` there) is live and waits on this; its server special-cases the call until `quest/core` names it. This follows the [telemetry epic](/quest/m0/telemetry/README.md)'s order, a shape in `quest/core` before any client sends or reads it.

- Adopt the live wire unchanged: request `{ pull: { owner, repo, number } }`; answer `{ value: Writer[], asOf: null }`, where `Writer` is `{ harness, model: string | null, effort: string | null, arm: string | null, cost, complete }`, largest cost first, a null model being cost no model was recorded for.
- Add it to `ForgeCalls`, `FORGE_READS`, and the request and answer parsers in `src/core/forge.ts`. Only Kixel Quest answers it, as GitHub records no writer, so `GitHubForge` needs no implementation beyond what the types demand; refuse it there loudly rather than answer an empty list.

Tests: the parsers accept the shape above and refuse a writer missing a field or a cost that is not a number.
