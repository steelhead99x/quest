# [S] Thin shared GitHub Actions action and reusable workflows

## Goal

`kixel-ai/quest` ships one composite action and a minimal set of reusable GitHub Actions workflows so repositories delete their copy-pasted `.github/actions/nix` actions and boilerplate workflow YAML for the jobs that remain on GitHub Actions:

- **Composite action (`.github/actions/setup-nix`):** installs Nix (`determinate: false`), sets `accept-flake-config = true` so `flake.nix`'s `nixConfig` (`nix.kixel.quest`) is trusted on first run, and optionally wires `mbx` for S3/B2 Rust caching.
- **Reusable workflows (`.github/workflows/`):**
  - `platform.yml`: dispatches public macOS and Windows `nightly` and `release-gate` tasks with explicit scope (`quest run --tier nightly --os <os> --all` for scheduled/coalesced nightlies, and `quest run --tier release-gate --os <os> --base <event-base-sha>` or `--all` for release PRs) and uploads `kixel-metrics` (`junit.xml` + `metrics.json`) for Kixel Quest ingestion.
  - `npm-publish.yml`: minimal GitHub-hosted npm OIDC trusted publishing workflow (since npm accepts OIDC tokens only from GitHub's runners).

## Plan

Decided 2026-11-26 (maintainer, `/quest-plan`, see the [CI epic](/quest/m0/ci/README.md)):

- ✅ Keep Linux CI (`main` queue, `release` queue, nightly Linux, isolated deploys) native on Kixel Quest hosts, and maintain thin shared GitHub Actions workflows here only for public macOS/Windows legs (until mesh or native non-Linux hosts cover them) and npm OIDC publishing (rejected: duplicating `.github/actions/nix` across 7+ repos; running Linux CI on GitHub Actions).

Decided 2026-11-27 (maintainer): no shared `check.yml`. CI runs no checks on pull requests, outside contributors' included: agents run them locally before pushing, and the merge queue, which only a maintainer's pick enters, is the only synchronous gate.

Implementation notes:

- Pin all third-party GitHub Actions by full commit SHA and lint every workflow and action with `actionlint` and `zizmor --offline` in `just check`.
- Version reusable workflow calls cleanly by tag/SHA so downstream repos opt in explicitly and never load unreviewed `@main` workflow code with write permissions.

Tests: `actionlint` and `zizmor --offline` pass on all shipped actions and workflows; verify a downstream test workflow calling `setup-nix` and `platform.yml` runs `quest run --tier nightly` and uploads `kixel-metrics`.

## Required

- [quest.lib.mkFlake](/quest/m0/ci/nix-lib.md) - establishes the `nix.kixel.quest` `nixConfig` trusted by `setup-nix`
