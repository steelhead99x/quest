# Test coverage audit

The goal is behavior that matters covered by tests, and every test running in CI.
The scope is every test suite, harness, and fixture the repository keeps; what tests cost belongs to the `cost` audit.

Look for:

- Gaps: public functions and branches no test executes. Start from coverage reports CI already produces; otherwise measure each package once without committing the tooling, and note what the tool cannot see, such as modules no suite loads. Confirm a gap in the tests before acting on it, and rank gaps by what breaks if the code is wrong, such as billing, auth, and data loss, not by percentage.
- Unreachable tests: test files and targets no CI job runs, skipped tests, suites gated on an environment variable, and CI steps whose failure skips the steps after them, so their tests look run.
- Missing regression tests: fixes merged since the last run that added or changed no test.
- Wall-clock tests: tests that sleep or depend on real timing instead of a mocked clock.
- Drifted mirrors: mocks, fixtures, and models that copy an outside contract or the code by hand, checked against what they copy.

Add missing tests and fix wall-clock ones in the run's PR, and delete a test that cannot run or checks nothing, saying what covers its behavior instead.
Coverage that needs new infrastructure, such as hardware or a live service, is a follow-up.
Record each package's coverage, and how it was measured, as the next stub's baseline.
