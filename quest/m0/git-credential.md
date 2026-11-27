# [S] Quest login signs git in to Kixel Quest's hosted repositories

## Goal

After `quest login`, `git clone`, `fetch`, and `push` of `https://kixel.quest/<owner>/<repo>.git` authenticate with the host's token with no further setup, and `quest logout` undoes it.
Kixel Quest's git endpoint already takes the token as HTTPS Basic `<any user>:<token>`.

Non-goals: SSH remotes; signing in to GitHub, which `gh auth setup-git` does.

## Plan

Found 2026-11-27 while planning kixel-ai/kixel.quest's move of its first repository onto its own forge (`quest/m0/forge/migrate/kixel-ai.md` there), which waits on this.

Agent's choices, the way `gh auth setup-git` configures GitHub:

- `quest login`, once the token is stored, writes two entries to the person's global git config under the URL `kixelUrl` names: an empty `credential.<url>.helper`, which drops any helper configured earlier (such as `osxkeychain`) for that URL only, then `!quest git-credential`. It prints that it did.
- `quest git-credential` (hidden) speaks git's credential helper protocol: `get` answers user `quest` and the token `login.json` holds for that URL, read on every call, so signing in again rotates it with no config change; `store` and `erase` do nothing, since `login.json` stays the only copy. With no token for the URL it prints `quest login` on stderr and answers nothing, so git fails.
- The helper runs `quest` from `PATH` rather than an absolute path, so an upgrade through mise or Nix does not break it.
- `quest logout` removes exactly those two entries, after the revoke [logout revoke](/quest/m0/telemetry/logout-revoke.md) adds, and before deleting the token. A config it cannot write fails the command naming the entries, so a read-only, home-manager-managed `~/.gitconfig` gets an error to act on.
- Update the README's `quest login` and `quest logout` sections.

Tests: with `HOME` and `XDG_CONFIG_HOME` in a temporary directory, `quest login` against a local Worker leaves a config with which `git clone` and `git push` of a hosted repository succeed, and `quest logout` leaves the config as it was before login; `git credential fill` for another host is not answered.

## Related

- [Logout revoke](/quest/m0/telemetry/logout-revoke.md) - the other half of `quest logout`
- [Hosted origins](/quest/m0/telemetry/hosted-origins.md) - records for sessions in those clones
