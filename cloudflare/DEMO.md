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
bun run demo --port 8790        # http://localhost:8790
bun run demo:e2e    # in another shell, with Chrome installed
```

`demo:e2e` walks the demo in headless Chrome at a phone's size: sign in, the
board, a claimed quest's CI, re-running failed jobs, dispatching a workflow,
the bench, installing to the home screen, opening offline, accessibility, and
signing out. The accessibility step runs axe-core's WCAG 2.2 AA and
best-practice rules on the home page, board, a quest, the bench, and the
offline notice, in light and dark, and measures every text element's contrast
itself (`demo/a11y.ts`), since the pages' decorative layers leave axe's own
contrast rule undecided.
It asserts each step, saves a screenshot of each to `.tmp/demo/`, prints a
report, and exits 1 on any failure. `bun run test` also walks the demo's
sign-in, board, re-run, dispatch, and bench inside workerd.

The demo keeps its claims and runs in memory, so restarting it resets them.

## Run the Android bench against the demo

Start the demo on port 8790. On a computer with an authorized Android
device attached over USB, forward that port to the phone:

```sh
adb reverse tcp:8790 tcp:8790
```

Open `http://localhost:8790/` in Chrome on the phone and select **Sign in
with GitHub**. The demo signs in as `demo`. From `cloudflare/`, run:

```sh
bun run device-bench --device android --runs 5 --shots ../.tmp/shots \
  --url http://localhost:8790/ --url http://localhost:8790/repos/steelhead99x/quest
adb reverse --remove tcp:8790
```

Use the report for a local smoke test. Reserve `--record` for baselines
measured against the deployed site.
