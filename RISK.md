# Risk

`quest review` reads this file from the base to set each PR's risk tier, as
the README's Risk tiers section describes. Risk is blast radius: who a
mistake in the change reaches before a check or a revert catches it.

`quest` runs development in moq-dev's and Kixel's repositories. What merges
to `main` ships in the next release, which contributors and the maintainer's
hosts install, and a revert ships in the one after.

Who relies on what here:

- Every agent session in those repositories loads the rules and skills under
  `assets/`, and acts on their wording with no check in between.
- Kixel Code imports the `quest/core` and `quest/github` exports.
- Skills, Kixel Code, and scripts parse the records `quest` writes into PR
  bodies and sends, and the output of `quest status`, `quest usage`, and
  `quest unblocked`.
- The reviewer's sandbox and the credentials `quest` passes to the agents it
  starts keep a change from instructing its own reviewer or reaching a
  secret.

A change is high when a mistake in it reaches them before anything catches
it:

- It breaks a consumer of an export, a record, or that output: it removes or
  renames one, changes what an existing field or line means or how it is
  written, makes a reader refuse what the previous release wrote, or adds
  what a consumer must now supply. Such a change marks its title with `!`,
  though a `!` for a CLI flag alone is not this.
- It changes when an agent may push, merge, post, or spend without asking,
  or what `quest` plants in a repository or injects into an agent's context,
  such as hook context, skill stubs, and the reviewer's and classifier's
  prompts. A command's output is not this.
- It changes the reviewer's sandbox or the credentials an agent gets, or
  sends a new kind of data off the host or into a public comment. New fields
  in a record `quest` already sends are not this.

Everything else that changes behavior is medium, which is most changes: a new
or changed command or option, a bug fix, an export or field that existing
consumers keep parsing, this repository's own agent instructions, its CI scripts, and a dependency
or pin bump; its workflows and actions are high, as every repository's are. A bug agents act on while its
release is live is a risk every one of them carries.

Tests, plans under `quest/`, and documentation change nothing others rely
on, so they are low.

## Automatic

A low PR whose author has write access lands without the maintainer's pick
when its whole diff falls in one class below, or in quest's built-in
`quest` class for plans under `quest/`, judged by the diff alone:
a PR title's commit type is only the author's claim. Only a PR the
maintainer picks changes this list, proposed with `quest usage`'s numbers
for the class: its PRs merged, the culprits among them, and their wait on a
person.

- `test` (`test/**`, `scripts/*.test.sh`, `scripts/*-bench.sh`) - only
  tests, their fixtures, or benchmarks change; the other check scripts stay
  out, since the release workflows run them before or after publishing
- `refactor` - code changes that keep every behavior and output the same,
  such as a rename inside a module, a simplification, or a comment-only
  change
- `chore` - a dependency or pin bump at any tier, or another change as
  small that is not high, from any author

## High

- `assets/` - the rules, guide, skills, and audits every repository's
  agents load from `quest`, including when they may write remotely or merge
- `SETUP.md` - the install steps agents follow from `main` when a skill
  stub finds no `quest`
- `src/cli/rules.ts` - the rules `quest context` prints and `quest hook`
  enforces on every agent's tool calls
- `scripts/installer.sh` - users pipe it to a shell, and a release
  publishes it as it is
- `scripts/release-plan.sh` - it decides which merges publish a release
