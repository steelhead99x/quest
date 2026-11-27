# [XS] Quest logout revokes its token at Kixel Quest

## Goal

`quest logout` revokes the host's token at Kixel Quest before deleting it from `login.json`, so a logged-out host's token stops working at once instead of until someone revokes it on the Tokens page.
A failed revoke fails the command and keeps the local token, so the person can retry.

## Plan

Decided 2026-11-26 (maintainer, /quest-run): ✅ keep this follow-up of [kixel-ai/quest#928](https://github.com/kixel-ai/quest/pull/928) (rejected: logout stays local-only).

Recommended, for the implementer to confirm: call the revoke endpoint kixel.quest's logout quest defines (planned as `POST /login/revoke`, RFC 7009, the token revoking itself), and update `quest logout`'s message and the README, which today say to revoke the token on the Tokens page.
Tests: against a local Worker, `quest logout` revokes the token and a later post with it is refused; a refused revoke leaves `login.json` unchanged.

## Waiting

- kixel-ai/kixel.quest: its logout quest (`quest/m0/insight/logout.md`, planned in [kixel-ai/kixel.quest#206](https://github.com/kixel-ai/kixel.quest/pull/206)) deploys the endpoint where a token revokes itself. Check that the file is gone from that repository's tree.

## Related

- [Git credential helper](/quest/m0/git-credential.md) - `quest logout` also removes the git config `quest login` writes
