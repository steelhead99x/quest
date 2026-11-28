# [M] Pass the native Windows suite again

## Goal

The nightly `windows` task (`quest.toml`, run by `.github/workflows/windows.yml`
through `platform.yml`) passes on `windows-2022` and `windows-11-arm`, so a
Windows regression shows as a red run instead of hiding among old failures.

## Plan

Found 2026-11-27 while validating [kixel-ai/quest#969](https://github.com/kixel-ai/quest/pull/969):
the nightly had failed every day since at least 2026-11-23, before that PR, with
about 21 tests failing on both architectures. Reproduce each on a Windows
runner, dispatching `windows.yml` on a branch, and fix it at its root cause:

- `test/start.test.ts` (9): Windows paths (`C:\Users\...`) where the test expects
  POSIX ones, and `git add -A` warning about line endings.
- `test/gate.test.ts` (4): memory admission and place expiry.
- `test/service.test.ts` (3): Linux and macOS service cases fail with `quest is
  not on PATH`, which should be skipped or stubbed off their platform.
- `test/login.test.ts`: the token file's mode reads 438 (`0o666`), not 384
  (`0o600`), as Windows has no POSIX modes.
- `test/response-cache.test.ts`: concurrent writers hit `EPERM` on `rename`.
- `test/land-bump.test.ts`: a symlink out of the checkout is not refused.
- `test/rules.test.ts` and `test/worktree.test.ts`: one case each.

A test that cannot hold on Windows is skipped there with a one-line reason,
never loosened.
