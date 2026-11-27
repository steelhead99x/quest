# [M] quest.lib.mkFlake Nix helper and fast quest fmt

## Goal

`kixel-ai/quest`'s `flake.nix` exports a self-contained `lib.mkFlake` helper so downstream repositories eliminate duplicated flake boilerplate without adding extra flake inputs, and `quest` ships fast formatting (`quest fmt`):

- `quest.lib.mkFlake` takes a repository's `nixpkgs`, systems, dev-shell packages/hooks, optional `packages`/`checks`, and optional `fmt` formatters (`nixfmt`, `rustfmt`, `biome`, `shfmt`, `taplo`, `ruff`, etc.), hiding `treefmt-nix` internally so downstream repos pin only `nixpkgs` and `quest`.
- Automatically injects `quest` into `devShells.default`, builds the `treefmt` wrapper directly onto `$PATH` inside `devShells.default` (and exports `formatter`), sets `QUEST_DEV_SHELL` to the repository's root in `devShells.default` so `quest run` skips nested `nix develop`, adds `checks.quest` (`quest check`), and documents/checks the shared `nix.kixel.quest` `nixConfig`.
- `quest fmt` invokes the dev shell's `treefmt` directly (~50ms, zero Nix eval) unless overridden by `[tasks.fmt]` in `quest.toml`, while `nix fmt` remains available for external callers.

## Plan

Decided 2026-11-26 (maintainer, `/quest-plan`, see the [CI epic](/quest/m0/ci/README.md)):

- ✅ Plain `quest.lib.mkFlake` hiding `treefmt-nix` internally so repos add zero extra flake inputs (rejected: exposing a `flake-parts` module that forces downstream repos to adopt `flake-parts`).
- ✅ Default `quest fmt` to `treefmt-nix` via `quest.lib.mkFlake`, putting the built `treefmt` wrapper directly on `$PATH` in `devShells.default` for ~50ms latency (rejected: calling `nix fmt` on every local run, which pays 1-3s Nix eval; manual `tasks.fmt` per repo).
- ✅ One shared `quest cache push` implementation replacing `moq/sh/gh/cache.sh` and `moq/infra/nix/justfile`. Its own quest is now [cache push](/quest/m0/ci/cache-push.md), split out on 2026-11-27 since it waits on Kixel Quest's Worker; its credentials follow the newer decision recorded there.

Implementation notes:

- Note that Nix reads `nixConfig` only from the top-level `flake.nix` attrset (not from `outputs`), so `quest check` verifies a repo opting into Kixel Quest sets `nixConfig`'s substituter to `https://nix.kixel.quest` (and `quest init` or a snippet documents the 4-line `nixConfig` block). [Cache push](/quest/m0/ci/cache-push.md) adds the public key to the check once Kixel Quest publishes it.

Tests: Nix flake evaluation test of `quest.lib.mkFlake` verifying `devShells.default`, `formatter`, `checks.quest`, and `treefmt` on `$PATH`; benchmark confirming `quest fmt` runs in under 200ms inside the dev shell on a fixture repo.
