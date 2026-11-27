# Documentation audit

The goal is documentation that matches the code: stale claims, broken examples and links, and undocumented exports are fixed or planned.
The scope is everything the repository documents outside `quest/`: guides, READMEs, runbooks, the docs site, code comments, snippets users copy, and doc comments on exported items.
Files agents load as instructions, such as `AGENTS.md` and `CONTRIBUTING.md`, belong to the `instructions` audit.

Look for:

- Stale claims: read the pages no recent change touched claim by claim against the code, starting with tables and lists of packages, features, platforms, or options. Prose that repeats a count, version, or list the code holds goes stale; point to the source instead.
- Broken examples: every command a doc shows parses with `--help` appended, every option or property it names exists, and every snippet builds against the current API.
- Broken links: local targets exist, and every external URL answers a GET, not a HEAD, sent with a browser user agent. Check a package on its registry's API, since some registry pages answer 200 for any name.
- Undocumented exports: exported items without a doc comment, found with each language's missing-docs lint where the build doesn't already enforce it.
- Parity: where the repository ships one feature in several languages or bindings, one that lacks it or documents it differently.

Check claims about deployed systems and outside services read-only, never by deploying or changing them.

Fix what is wrong in the run's PR.
Record the commit this run read as the next stub's baseline, so the next run starts from what changed since.
