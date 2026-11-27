# Running an audit

This quest is an audit stub: its `## Audit` section names the definition above, which quest ships so every repository runs the same audit.
The stub's Plan holds only what this repository learned, and wins where it narrows the definition.

## Findings

Fix in the run's PR what is mechanical or already decided.
For each kind of finding, also fix what let it in, so the next run finds none: a fast gate check, a test, a simpler design, or an `AGENTS.md` rule proposed under `## Waiting` as `quest guide prompting` describes.
Work that needs its own PR is a follow-up, as the guide's Creation section describes.
A run cannot prompt, so each decision goes under the PR's `## Waiting` as a `Maintainer:` decision, its options a choice list with your recommendation marked.

## Next run

The PR finishing this run plans the next one in the same change:

1. Delete this stub with `quest rm`, which also removes its path from every `Required`, so nothing waits on the next run by accident.
2. Create it again, under the same file name, in the next milestone: `quest/m1/audit-deps.md` becomes `quest/m2/audit-deps.md`. Create that milestone's README with a one-line Goal when it is missing.
3. Title it as `quest audit` lists this audit, size included, since quest ships one size per audit. Keep its Goal and `## Audit` section. Give it a `## Required` link to the milestone this run sat in, so it runs once per milestone, unless this stub named another trigger, such as a release cut, which it keeps. When deleting this stub left that milestone with no quest and no `Required`, it is finished, so leave the link out. Give it a `## Scheduled` date one week after today, so a milestone that closes fast does not rerun the audit at once.
4. Carry forward in its Plan only what this repository learned: its baseline, the scope it excludes, and what to check first. Findings and results stay in this run's PR.

Run `quest check` after.
