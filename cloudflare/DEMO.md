# Demo

The demo runs the real Worker against a stand-in GitHub (`demo/github.ts`),
so every page and action works with no App, Cloudflare account, or network.
It serves this checkout's real quest tree and workflow files, with made-up
claims, CI runs, and merged PRs around them: one quest handed back as a
draft, one in review with a failed check to re-run and a run awaiting
approval, and five merged quests for the bench. GitHub's sign-in page is
answered at `/demo/authorize`, which signs you in as `demo` at once.
Nothing in `demo/` ships in the real Worker (`src/index.tsx`).

```sh
cd cloudflare
bun run demo        # http://localhost:8790
bun run demo:e2e    # in another shell, with Chrome installed
```

`demo:e2e` walks the demo in headless Chrome at a phone's size: sign in, the
board, a claimed quest's CI, re-running failed jobs, dispatching a workflow,
the bench, installing to the home screen, opening offline, and signing out.
It asserts each step, saves a screenshot of each to `.tmp/demo/`, prints a
report, and exits 1 on any failure. `bun run test` also walks the demo's
sign-in, board, re-run, dispatch, and bench inside workerd.

The demo keeps its claims and runs in memory, so restarting it resets them.
