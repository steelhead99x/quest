# [XS] Codex keeps a way to skip project config

## Goal

Codex offers a supported way to skip a project's `.codex/` layer while
keeping the user's config. Once a release has it and the review harness check
passes with it, `quest review` uses it instead of `--ignore-user-config`,
which drops the user's model provider and profiles, and this quest is
deleted.

## Plan

Decided 2026-10-28 (user, /quest-plan of the follow-ups from [kixel-ai/quest#271](https://github.com/kixel-ai/quest/pull/271)).

- [openai/codex#49333](https://github.com/openai/codex/issues/49333) reports
  that `--ignore-user-config` also skips the project layer, unlike its help
  text. #271 relies on exactly that to keep a reviewed head's MCP servers and
  hooks from running. A fix that matches the help text would reopen that hole.
- Do not post upstream, on #49333 or a new issue; the maintainer declined.
  Only watch for the change.

Checked 2026-11-14 against Codex 0.169.0, whose
[openai/codex#60041](https://github.com/openai/codex/pull/60041) keeps an
untrusted directory's project config and MCP servers off in `codex exec`:

- That is no way to skip the layer, since a reviewed checkout is often
  trusted, such as a worktree or clone the user's config trusts. Without
  `--ignore-user-config`, `just review-sandbox -t codex` fails its trusted-home
  case: the planted `.codex/config.toml` MCP server and SessionStart and
  UserPromptSubmit hooks all ran. Its untrusted-checkout case passed.
- A per-run `-c 'projects."<checkout>".trust_level="untrusted"'` does not
  override the user config's trust either: the same case ran the same plants.
- With `--ignore-user-config`, 0.169.0 still passes the codex cases.
- `--trust` only grants trust, and refuses to combine with
  `--ignore-user-config`.

## Waiting

- openai/codex: a release offers a way to skip a project's `.codex/` layer, or
  to mark one run's directory untrusted, that holds when the user's config
  trusts the directory. Check #49333 (open on 2026-11-14) and Codex release
  notes each time ready work is triaged; a note that only covers untrusted
  directories does not qualify. Verify by replacing `--ignore-user-config`
  in `codexFlags` in `src/cli/review.ts` with the release's flag or setting,
  if it needs one, and running `just review-sandbox -t codex`, whose
  trusted-home case must pass.
