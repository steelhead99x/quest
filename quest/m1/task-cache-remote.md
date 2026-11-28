# [M] Share task results across hosts through Kixel Quest

## Goal

`quest run` reuses a task's or crate's pass from any trusted host, not only its own: after a miss in this user's cache on disk, it looks up the digest in Kixel Quest's task-result cache, and a trusted run uploads each pass with its JUnit XML and metrics.

- A hit from Kixel Quest counts and prints like a local one, `cached (hit)`, and is also kept in the local cache.
- Only a trusted run, such as the merge queue, `main`, nightly, or release, uploads; an untrusted one, such as a pull request or a contributor's machine, reads hits without uploading.
- A public repository's lookups and uploads never reach a private repository's results, and the reverse.
- Each run reports its hit and miss counts to Kixel Quest.

## Plan

Decided 2026-11-27 (maintainer, `/quest-run`): the m0 client half landed first with a per-host cache, and this quest adds the remote half (see the [CI epic](/quest/m0/ci/README.md)).

- Send the m0 digest unchanged: it covers the dev shell's derivation, run script, environment, report paths, OS and CPU, the tasks run first, and Git blob ids under paths from the repository root, so two checkouts of the same content on the same toolchain agree.
- Prove trust with a runner credential from Kixel Quest, not a person's `quest login` token, which cannot show that the run built reviewed code.
- Keep `--no-cache` and `cache = false` bypassing the remote cache as they bypass the local one.

Tests: against a mocked Kixel Quest, a trusted run uploads a miss's pass, a second host's run takes it, an untrusted run reads hits without uploading, and a failed lookup fails the run instead of quietly running everything.

## Waiting

- kixel-ai/kixel.quest: the task-result lookup and upload endpoints its `quest/m1/ci/task-cache.md` plans, which wait on its runner credential in `quest/m1/ci/runner.md`; check that quest file is gone and the endpoints are documented.

## Related

- [CI epic](/quest/m0/ci/README.md) - the m0 client half and the merge queue's trust in local passes
