# [S] Gate and admission honor background.slice's memory cap before its cgroup exists

## Goal

On Linux, `quest gate` and `quest agent admit` bound memory by the user's `background.slice` cap even while the slice has no cgroup, as after login before the first gated build. Today `linuxMemory` (`src/cli/gate.ts`) reads the cap only from the slice's cgroup files and skips the slice when the cgroup is missing, so the first build is admitted, and its budget sized, against host memory rather than the cap.

Non-goals: other platforms, slices other than `background.slice`, and limits on the slice's ancestors beyond what the existing cgroup walk reads.

## Plan

Decided 2026-11-27 by the maintainer (`/quest-run`): ✅ when the slice's cgroup is missing, ask systemd for the cap with `systemctl --user show background.slice -p MemoryMax,MemoryHigh` inside `linuxMemory`, the one reader the gate (`fileHost`'s `memory`, `usableMemory`) and admission (`src/cli/admission.ts` through `sliceUser`) share, and fail loudly on a malformed answer (rejected: leave the first build uncapped as documented today).

Caused by [kixel-ai/quest#904](https://github.com/kixel-ai/quest/pull/904), which added the slice bound and its skip for a missing cgroup; [kixel-ai/quest#964](https://github.com/kixel-ai/quest/pull/964) carried the same reader into admission.

Recommendations:

- `systemctl --user show` reports each property as a byte count, with percentages already resolved against RAM (a drop-in's `MemoryHigh=50%` reads `MemoryHigh=32421265408` on a 64 GB host), or `infinity` when unset. Bound `total` by the smaller of the two and `available` by it too, since nothing yet runs in the slice. Throw on any other value, a missing property, or a failed `systemctl`: a `uid` reaches `linuxMemory` only for a command run in a scope (`sliceUser`), so the user manager is there to answer.
- The probe is for the caller's own user manager, which matches `sliceUser` returning `process.getuid()`; keep that coupling explicit rather than probing for an arbitrary `uid`.
- `bound` already treats a missing cgroup file as an unset limit, so the slice's ancestors (`user@<uid>.service`, `user-<uid>.slice`) can be walked from the slice path whether or not it exists; only the slice's own cap needs systemd.
- Probe only while the cgroup is missing, which spares every later poll the spawn. Make the probe injectable for tests; `linuxMemory` already takes three positional arguments, so move them into one options object rather than add a fourth.
- Update the comment above the slice check in `linuxMemory` and any README line that says the first build runs uncapped.

Tests (`test/gate.test.ts`, beside the existing background-slice test): with no slice cgroup, an injected answer caps `total` and `available`; `infinity` for both leaves the host's answer; a malformed or missing value throws; an existing slice cgroup is read from its files without calling the probe.

Validation on the real surface: run `linuxMemory` against a fake cgroup root that lacks the slice, with the real `systemctl` answering, and check the cap matches `systemctl --user show background.slice -p MemoryHigh`. Do not stop `background.slice` to empty it, since that kills other sessions' gated builds.
