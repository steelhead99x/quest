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

This epic finishes once every child lands and a real repository validates `quest.lib.mkFlake`, `quest fmt`, `quest run --tier gate`, `quest cache push`, and content-addressed crate skipping end to end.
