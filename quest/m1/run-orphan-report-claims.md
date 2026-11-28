# [S] A retry stays out of a report an orphaned task still writes

## Goal

When `quest run` and its `quest gate` are both killed while a task they started runs on (a CI job's cgroup kill can leave a task's systemd scope running), a retry in the same checkout refuses that task's report paths until the task itself exits, as it does while the run or its gate lives.

## Plan

Found reviewing steelhead99x/quest#30, which claims report paths with an OS file lock that `quest run` and the gate it starts hold: a killed holder leaves no claim behind, and no hard links are needed. Its first attempt also handed the lock descriptors from the gate to the task, past a killed gate, and review found that each way of doing so leaks the claim somewhere: the task can reuse descriptor 6 and drop it, an in-scope keeper may not be running before the task starts and lets go during the task's graceful shutdown, and the systemd launcher holds it before admission. That PR landed the lock alone.

- Give the scope one supervisor process, started before admission is acknowledged, that owns both the lock descriptors and the task's lifetime: it starts the task with the descriptors closed, forwards signals to it, and exits only after the task has, so the locks fall exactly when the last writer does.
- Keep the descriptors out of `systemd-run` itself, so a start job that never runs holds nothing.
- Test it on the systemd path with a task that reuses descriptor 6 and one that traps SIGTERM and keeps writing, each after its run and gate are killed.
