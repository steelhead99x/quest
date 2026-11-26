# [XS] Bun's EFAULT on concurrent rmSync

## Goal

Bun no longer throws `EFAULT` from `rmSync(file, { force: true })` on Windows
when two processes remove the same file at once (Node throws `EPERM`). Once a
Bun release fixes it and Quest's pin includes that release, `remove()` in
`src/cli/gate.ts` stops tolerating `EFAULT`, and this quest is deleted.

## Plan

- [kixel-ai/quest#233](https://github.com/kixel-ai/quest/pull/233) found the
  race and worked around it. Its diagnostic runs have the minimal repro: two
  processes `rmSync` the same file on `windows-11-arm` and `windows-2022`.
- Reported upstream on 2026-11-14 (approved by the user, 2026-10-28) as a
  [comment with the Windows repro and counts](https://github.com/oven-sh/bun/issues/48811#issuecomment-6882793150)
  on [oven-sh/bun#48811](https://github.com/oven-sh/bun/issues/48811), the
  report filed 2026-11-13 that matches this exactly but had no Windows run.
- The fix to wait for is
  [oven-sh/bun#48816](https://github.com/oven-sh/bun/pull/48816), open: it makes
  non-recursive `rm` report the errno `unlink` returned, so the losing caller
  gets `EPERM` as in Node. `remove()` already tolerates `EPERM`, so only the
  `EFAULT` entry goes.
- The recursive case is
  [oven-sh/bun#39708](https://github.com/oven-sh/bun/issues/39708) with its fix
  [oven-sh/bun#39710](https://github.com/oven-sh/bun/pull/39710), both open.
  [oven-sh/bun#38550](https://github.com/oven-sh/bun/pull/38550), the earlier
  single-file fix, closed unmerged on 2026-11-13.

## Waiting

- oven-sh/bun: a release carries a fix for
  [oven-sh/bun#48811](https://github.com/oven-sh/bun/issues/48811) (likely
  [oven-sh/bun#48816](https://github.com/oven-sh/bun/pull/48816)), and Quest's
  pin includes it. Check the issue and the fix PR each time ready work is
  triaged.
