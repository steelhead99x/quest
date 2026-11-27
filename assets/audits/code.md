# Code audit

The goal is code that earns its complexity: nothing unused, nothing overbuilt, and every lint suppression still needed.
The scope is the repository's own code in every language it uses, including build scripts, task recipes, CLI flags, config keys, and API routes.
Dependencies belong to the `deps` audit; vendored and generated code keeps its upstream's surface.

Look for:

- Dead code: code, exports, flags, config keys, routes, and recipes nothing uses. Compilers miss unused public items, so shortlist public declarations whose name appears nowhere but their definition, and give a dead-code tool every real entry point, such as tests, examples, benches, and scripts, before trusting it. Trace a flag or config key through the code that reads it, not the docs.
- Overbuilt code: duplicate mechanisms, and layers, options, traits, and generics with one user, starting from the largest modules. Find a helper written more than once by searching for its body, not its name, and a type both ends of one message declare separately.
- Lint suppressions: each still needed and saying why. Drop one at a time and rerun its linter on every platform and target the code builds for, not only the one CI lints, since a suppression for another platform looks stale on yours.
- Deprecated calls: APIs deprecated at the oldest toolchain or runtime the repository supports.

Where the code is too large for one reader, split the reading by area across parallel sub-agents; verify each claim before acting: a duplicate can be a test seam or a deliberate split, and an unused flag can be a tuning knob or an old spelling kept to fail with migration guidance.

Delete dead private code and land simplifications in the run's PR.
Removing or reshaping a public API or a user-visible flag, route, or field, and narrowing a feature, are the maintainer's decisions: each is a follow-up with a recommendation and how users migrate.
Record what was checked and kept on purpose, with why, as scope the next stub excludes.
