# [M] Read GitHub on the caller's token while Kixel Quest's quota is spent

## Goal

When Kixel Quest (https://kixel.quest) cannot read GitHub for a repository because its own installation token's rate limit is spent, `quest`'s reads of that repository go to GitHub on the caller's token for the rest of the run, and it says so once on stderr, naming the reset, instead of failing.
Today `quest status` fails with `failed POST /forge/status: HTTP 502, GitHub failed the status read: GitHub's core rate limit for this token is spent until …; rerun this command with QUEST_FORGE=github; leave it unset otherwise, since it spends your GitHub quota`.

Non-goals: the person's own budget at Kixel Quest (its 429), which still fails naming when to retry, and repositories Kixel Quest hosts, which have no GitHub to read.

## Plan

Decided 2026-11-24 (maintainer, kixel.ai /quest-run): ✅ "reads GitHub with the caller's token and says so" (rejected: dropping this quest).

Decided 2026-11-24 (maintainer, [decision](https://github.com/kixel-ai/quest/pull/875#issuecomment-7152590368)): ✅ decide once per run (rejected: fall back per failed call). Decide from what Kixel Quest already reports, rather than retrying each failed call on GitHub. `KixelQuest.info()` in `src/cli/forge.ts` reads `GET /forge` to learn which repositories it serves; that answer will also name, per repository, until when its installation cannot read GitHub. Its cache lives on one `KixelQuest`, and today `kixelQuest(deps)` builds a new one on every `forgeFor` call, which the wait path (`choose` in `src/cli/main.ts`, called by `waitForActivity` in `src/cli/wait.ts` for each choice) repeats within one run. So this quest makes the decision run-wide: one `KixelQuest` per run (held on `deps`, built once), and `forgeFor` memoizes its choice per repository for the run, so every read of a repository in a run, a wait's repeated calls included, uses the same forge. `forgeFor` then picks `GitHubForge` on the caller's token for a spent repository and warns once per run per repository, for example `quest: Kixel Quest's GitHub quota for kixel-ai/kixel.ai is spent until 01:12; reading GitHub on your token`. This follows the repository's rule to decide a path at setup from known capabilities, costs no extra request, and keeps every read of a run on one forge. A per-call fallback would match the settled wording more literally, but mixes forges within one run and turns every 5xx into a guess about why.

A quota spent in the middle of a run still fails that command: Kixel Quest answers the read with a typed refusal (recommended: 503 with `Retry-After` and a `limited` reason, in place of today's 502 with prose), and the CLI's message names the reset and that the next run reads GitHub. The next run's `/forge` read sees the spend and switches.

The server half, the `/forge` field and the 503, is kixel-ai/kixel.quest's; this quest defines the wire in `src/core/forge.ts` and nothing here needs a compatibility path.

`quest pr edit`'s HTTP 401: on 2026-11-24 a kixel.ai agent ran `QUEST_FORGE=github quest pr edit https://github.com/kixel-ai/kixel.ai/pull/262 -t … -F …` and got `GitHub HTTP 401 for /repos/kixel-ai/kixel.ai/pulls/262; Bad credentials` from GitHub itself, then `gh pr edit` with the same arguments succeeded. `QUEST_FORGE` plays no part: on GitHub, `pr edit` always writes through `GitHubWrites` on `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`, the same token `gh` uses, and `quest status` read GitHub on it in the same session. It did not reproduce while planning: the same build (59b106e), on the same host and token with `QUEST_FORGE=github`, edited [kixel-ai/quest#875](https://github.com/kixel-ai/quest/pull/875)'s title. Since `GitHub.send` in `src/github/client.ts` retries no 401, a one-off `Bad credentials` from GitHub fails the write outright; reproduce it before changing anything, and fix it here only if the cause is in `quest`.

Tests: against a local forge whose `/forge` answer marks a repository's quota spent, `quest status`, `quest pr view`, and `quest start`'s open-PR read go to GitHub on the caller's token, the warning prints once per run, a `quest wait` whose `/forge` answer changes between choices keeps its first forge, and another repository still reads through the forge; a typed 503 mid-run fails the command naming the reset; a 429 still fails naming when to retry.

## Waiting

- kixel-ai/kixel.quest: `GET /forge` reports, for each repository it serves, until when its installation cannot read GitHub, and a forge read refused for that reason answers 503 with `Retry-After`. Check that kixel.quest's `/forge` answer carries the field.
