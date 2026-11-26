# [S] Offer the fork's CLI fixes upstream

## Goal

The four CLI and release fixes the fork landed
([steelhead99x/quest#2](https://github.com/steelhead99x/quest/pull/2),
restored by [#18](https://github.com/steelhead99x/quest/pull/18)) reach
kixel-ai/quest as one draft PR, rebuilt on upstream's current `main`, each
with its test. All four bugs are still on upstream's `main` as of 9029c02:

- `quest rm` runs `git rm -r` on an epic's directory, staging deletion of
  files that aren't quests, and passes paths as pathspecs, so a bracketed
  name also matches its siblings.
- The records sender follows redirects, so a 301 or 302 turns an upload
  into a GET whose 200 settles records nobody received.
- The installer and both post-release checks hard-code `kixel-ai/quest`,
  so a fork's release installs and checks upstream's binaries.
- `quest uninstall` removes the whole `merge.quest` section, custom drivers
  included.

## Plan

- Branch from upstream's `main` and port each fix and its test; the
  source fixes apply cleanly, and the five installer scripts need redoing
  against upstream's current ones (it renamed moq-dev/quest to
  kixel-ai/quest in a57434c).
- Follow upstream's current `quest context` for the PR body: its telemetry
  epic is moving `Implementer:` and `## Review` lines out of PR bodies.
- Draft only: the contributor may open drafts on kixel-ai/quest and nothing
  else (no ready-for-review, no merge, no comments).

Tests: upstream's `just check` and `just test`, each new test failing
without its fix.

## Waiting

- Contributor: open the draft PR on kixel-ai/quest from the pushed branch,
  with `gh pr create --draft -R kixel-ai/quest --head steelhead99x:<branch>`.
  An agent session here cannot: it has no GitHub API access to kixel-ai/quest.
