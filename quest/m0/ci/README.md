# Unified Nix-backed CI runner, flake helper, and shared workflows

## Goal

Any repository opting into Kixel Quest requires Nix (`flake.nix`) and declares its CI, caching, and release lifecycle in a root `quest.toml` (keeping `justfile` only for interactive local dev menus), using `quest` as its single CLI for running tasks (`quest run`), fast formatting (`quest fmt`), Nix cache publishing (`quest cache push`), flake boilerplate (`quest.lib.mkFlake`), and thin reusable GitHub Actions workflows for non-Linux legs and npm OIDC publishing.

Non-goals: configuring agent or review model routing in `quest.toml` (Quest keeps its single shipped model routing), moving interactive local dev menus (`just dev`, `just demo`) out of `justfile`, or owning the merge queue, host scheduler, or cache Worker (which live in Kixel Quest).

## Plan

Decided 2026-11-26 (maintainer, `/quest-plan`):

- **Ownership split.** ✅ CLI runner (`quest run`), diff and content-addressed task dispatcher, `quest cache push`, `quest.lib.mkFlake`, and thin shared GitHub Actions reusable workflows live here in public `kixel-ai/quest` (already pinned in every repository's `flake.nix`); the control plane (queues, nightly/release scheduling, CI runner dispatch, shared binary and artifact caches) lives in `kixel.quest` (rejected: keeping the runner/Nix helper private in `kixel.quest`; adding a third repo and pin loop).
- **Contract format and scope.** ✅ Root `quest.toml` covering CI and lifecycle stages only, keeping `justfile` for interactive local dev menus (rejected: task definitions inside `flake.nix`, which a Cloudflare Worker cannot evaluate and which add Nix eval/copy latency locally; dropping `justfile` for dev menus).
- **Flake helper.** ✅ Plain `quest.lib.mkFlake` hiding `treefmt-nix` internally so downstream repositories add zero extra flake inputs beyond `nixpkgs` and `quest` (rejected: requiring downstream repos to adopt `flake-parts`).
- **Formatting.** ✅ Default `quest fmt` to `treefmt-nix` via `quest.lib.mkFlake`, placing the built `treefmt` wrapper directly on `$PATH` inside `devShells.default` so `quest fmt` runs in ~50ms with zero Nix eval while `nix fmt` remains available, overridable by `tasks.fmt` in `quest.toml` (rejected: manual `tasks.fmt` per repo).
- **Three-layer caching.** ✅ Support Nix binary cache (`nix.kixel.quest`), shared S3/B2 `mbx` compilation caches, and content-addressed task/test result skipping in `quest run` (including `cargo metadata --locked` per-crate closure hashing) with strict public/private isolation (rejected: stopping at git-diff path selection).
- **Milestone.** ✅ `m0`: unlocks CI consolidation across `moq-dev` and `kixel-ai` repositories before public release (`m1`).

Decided 2026-11-27 (maintainer, `/quest-run`), since Kixel Quest has no task-result endpoint yet and a per-person `quest login` token cannot prove a run is trusted:

- **Split the result cache.** ✅ The client half landed in m0 with a per-host, per-user cache on disk: digests over the dev shell's derivation, run script, environment, OS and CPU, and input blob ids; per-crate Cargo closures from `cargo metadata --locked`; `cache = false` and `--no-cache`; and `cached (hit)` and `ran` summary lines with hit counts. The remote lookup and upload are [Share task results across hosts](/quest/m1/task-cache-remote.md) (rejected: holding all of it in m1; digests with no store).
- **Cargo discovery.** ✅ A separate `cargo = true` task key, since `inputs` holds path patterns (rejected: `inputs = "cargo"`).
- **Crate granularity.** ✅ A Cargo task runs once per crate with `QUEST_CRATE` set, so each crate's pass is cached on its own (rejected: one run cached per workspace).
- **Merge-queue trust in local passes.** ✅ Same user, same host: a host's cache is trusted exactly as far as the user account that holds it, since anything running as that user could already subvert its next run some other way. `quest run` refuses a cache directory another user owns or can write. The merge queue's runner user, separate from interactive and agent sessions, runs its gate with the cache only while it runs nothing but reviewed heads; a runner user that also runs unreviewed pull request code, such as an approved outside contributor's, runs its gate with `--no-cache` until the m1 remote cache, which only trusted runners write. Each host's runner setup, planned in kixel-ai/dotfiles' quest tree, applies it (rejected: the gate always runs `--no-cache` until m1).

This epic finishes once every child lands and a real repository validates `quest.lib.mkFlake`, `quest fmt`, `quest run --tier gate`, `quest cache push`, and content-addressed crate skipping end to end.
