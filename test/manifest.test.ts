// quest.toml: its schema, the problems a malformed one reports, and the tasks a run picks from it.
import { expect, test } from "vitest";

import { type Manifest, type TaskPick, parseQuestManifest, pickTasks } from "../src/core";

const manifest = (text: string): Manifest => {
	const parsed = parseQuestManifest(text);
	if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
	return parsed.manifest;
};

const problems = (text: string): string[] => {
	const parsed = parseQuestManifest(text);
	return parsed.ok ? [] : parsed.problems;
};

test("a task takes its defaults and every declared field", () => {
	const parsed = manifest(`
[repo]
merge = "trunk"
release = "release"
cache = ["devShells.default", "packages.default"]
invalidate_all = ["flake.lock"]

[tasks.lint]
tier = "pr"
run = "just lint"

[tasks.test]
tier = "gate"
run = """
cargo test
"""
after = ["lint"]
paths = ["rs/"]
exclude = ["rs/**/*.md"]
inputs = ["test/vectors/"]
caches = ["mbx"]
os = ["linux"]
capabilities = ["kvm"]
cache = false
environment = { RUST_BACKTRACE = "1" }
junit = "target/junit.xml"
metrics = "target/metrics.json"

[tasks.windows]
tier = "nightly"
run = "cargo build"
nix = false
`);
	expect(parsed.repo).toEqual({
		merge: "trunk",
		release: "release",
		cache: ["devShells.default", "packages.default"],
		invalidateAll: ["flake.lock"],
	});
	expect(parsed.tasks.map((task) => task.name)).toEqual(["lint", "test", "windows"]);
	expect(parsed.tasks[0]).toEqual({
		name: "lint",
		tier: "pr",
		run: "just lint",
		after: [],
		paths: null,
		exclude: [],
		inputs: [],
		caches: [],
		// Nix runs on Linux and macOS only.
		os: ["linux", "macos"],
		capabilities: [],
		nix: true,
		cache: true,
		environment: {},
		junit: null,
		metrics: null,
	});
	expect(parsed.tasks[1]).toMatchObject({
		run: "cargo test\n",
		after: ["lint"],
		paths: ["rs/"],
		exclude: ["rs/**/*.md"],
		inputs: ["test/vectors/"],
		caches: ["mbx"],
		os: ["linux"],
		capabilities: ["kvm"],
		cache: false,
		environment: { RUST_BACKTRACE: "1" },
		junit: "target/junit.xml",
		metrics: "target/metrics.json",
	});
	// Without Nix a task runs everywhere by default.
	expect(parsed.tasks[2]!.os).toEqual(["linux", "macos", "windows"]);
});

test("an empty manifest has the default repo and no tasks", () => {
	expect(manifest("")).toEqual({ repo: { merge: "main", release: null, cache: [], invalidateAll: [] }, tasks: [] });
});

test("a TOML syntax error names its line and column", () => {
	expect(problems("[repo]\nmerge = \n")).toEqual(["quest.toml:2:9: invalid value"]);
});

test("every malformed key and value is reported at once", () => {
	expect(
		problems(`
typo = 1
[repo]
merge = ""
branch = "main"
invalidate_all = ["/abs"]

[tasks."bad name"]
tier = "pr"
run = "x"

[tasks.a]
tier = "weekly"
run = ""
paths = "src/"
os = ["linux", "linux", "beos"]
nix = "yes"
environment = { QUEST_BASE = "x", "1X" = "y", N = 1 }
junit = "out/*.xml"
metrics = "../metrics.json"
runs = "x"

[tasks.b]
after = ["a"]
`),
	).toEqual([
		"quest.toml: top level: unknown key `typo`",
		"quest.toml: [repo]: unknown key `branch`",
		"quest.toml: [repo] merge: expected a non-empty string",
		"quest.toml: [repo] invalidate_all: `/abs`: it starts with /, but a pattern is a path from the repository root",
		"quest.toml: [tasks.bad name]: a task name holds only letters, digits, `_`, and `-`",
		"quest.toml: [tasks.a]: unknown key `runs`",
		"quest.toml: [tasks.a] tier: expected one of pr, gate, nightly, release-gate, release",
		"quest.toml: [tasks.a] run: expected a non-empty string",
		"quest.toml: [tasks.a] nix: expected true or false",
		"quest.toml: [tasks.a] os: `beos`: expected one of linux, macos, windows",
		"quest.toml: [tasks.a] os: `linux` is listed twice",
		"quest.toml: [tasks.a] environment: quest run sets `QUEST_BASE` itself",
		"quest.toml: [tasks.a] environment: `1X` is not a variable name",
		"quest.toml: [tasks.a] environment: `N` is not a string",
		"quest.toml: [tasks.a] paths: expected a list of strings",
		"quest.toml: [tasks.a] junit: expected a file path, not a pattern",
		"quest.toml: [tasks.a] metrics: it has an empty, `.`, or `..` segment",
		"quest.toml: [tasks.b]: missing `tier`",
		"quest.toml: [tasks.b]: missing `run`",
		"quest.toml: [tasks.b] after: `a` does not run on macos",
	]);
});

test("a Nix task cannot run on Windows", () => {
	expect(problems(`[tasks.a]\ntier = "pr"\nrun = "x"\nos = ["windows"]\n`)).toEqual([
		"quest.toml: [tasks.a] os: Nix does not run on windows; set `nix = false` for a task that runs there",
	]);
	expect(problems(`[tasks.a]\ntier = "pr"\nrun = "x"\nos = ["windows"]\nnix = false\n`)).toEqual([]);
});

test("after names a declared task of the same or an earlier tier that runs wherever the task does, without a cycle", () => {
	const task = (name: string, tier: string, after: string[], extra = "") =>
		`[tasks.${name}]\ntier = "${tier}"\nrun = "x"\nafter = ${JSON.stringify(after)}\n${extra}`;
	expect(
		problems(
			[
				task("a", "pr", ["missing"]),
				task("b", "pr", ["c"]),
				task("c", "nightly", []),
				task("d", "pr", ["e"]),
				task("e", "pr", [], 'os = ["linux"]\n'),
				task("f", "pr", ["g"]),
				task("g", "pr", ["f"]),
				task("h", "pr", ["h"]),
				// A release task may run after any tier.
				task("i", "release", ["c"]),
			].join("\n"),
		),
	).toEqual([
		"quest.toml: [tasks.a] after: no task is named `missing`",
		"quest.toml: [tasks.b] after: `c` is in the later tier nightly, so a pr run would pull it in",
		"quest.toml: [tasks.d] after: `e` does not run on macos",
		"quest.toml: [tasks.f] after: cycle `f` -> `g` -> `f`",
		"quest.toml: [tasks.h] after: cycle `h` -> `h`",
	]);
});

test("two tasks declare the same report file, without case, only when one runs after the other", () => {
	const reports = (after: string) =>
		problems(
			`[tasks.a]\ntier = "pr"\nrun = "x"\njunit = "out.xml"\n` +
				`[tasks.b]\ntier = "pr"\nrun = "x"\nafter = ${after}\n` +
				`[tasks.c]\ntier = "pr"\nrun = "x"\nafter = ["b"]\nmetrics = "OUT.xml"\n`,
		);
	expect(reports("[]")).toEqual([
		"quest.toml: [tasks.c] metrics: `a` may run at the same time and also writes `out.xml`",
	]);
	// c runs after b, which runs after a.
	expect(reports('["a"]')).toEqual([]);
	expect(problems(`[tasks.a]\ntier = "pr"\nrun = "x"\njunit = "out"\nmetrics = "out"\n`)).toEqual([
		"quest.toml: [tasks.a] metrics: is also the task's junit report",
	]);
});

const tasks = `
[repo]
invalidate_all = ["flake.lock"]

[tasks.build]
tier = "pr"
run = "build"
paths = ["src/"]

[tasks.test]
tier = "pr"
run = "test"
after = ["build"]
paths = ["src/", "test/"]
exclude = ["src/**/*.md"]
inputs = ["fixtures/"]

[tasks.lint]
tier = "pr"
run = "lint"

[tasks.docs]
tier = "pr"
run = "docs"
paths = []

[tasks.e2e]
tier = "gate"
run = "e2e"
after = ["build"]
paths = ["src/"]
os = ["linux"]

[tasks.bench]
tier = "nightly"
run = "bench"

[tasks.publish]
tier = "release"
run = "publish"
after = ["build"]
`;

const pick = (overrides: Partial<TaskPick>): string[] =>
	pickTasks(manifest(tasks), { tier: "pr", only: null, changed: [], os: ["linux"], ...overrides }).map(
		(task) => task.name,
	);

test("a change picks the tasks whose paths or inputs it touches and none it only excludes", () => {
	expect(pick({ changed: [] })).toEqual([]);
	// A task without paths, lint, takes any change; docs' empty list takes none.
	expect(pick({ changed: ["README.md"] })).toEqual(["lint"]);
	// test runs after build, which a pick of test runs too.
	expect(pick({ changed: ["test/a.ts"] })).toEqual(["build", "test", "lint"]);
	expect(pick({ changed: ["fixtures/x.json"] })).toEqual(["build", "test", "lint"]);
	expect(pick({ changed: ["src/a.ts"] })).toEqual(["build", "test", "lint"]);
	// test excludes src's Markdown, which build still reads.
	expect(pick({ changed: ["src/notes.md"] })).toEqual(["build", "lint"]);
});

test("a run of a tier also runs the tiers before it, and a release run only release tasks", () => {
	expect(pick({ tier: "gate", changed: ["src/a.ts"] })).toEqual(["build", "test", "lint", "e2e"]);
	expect(pick({ tier: "nightly", changed: null })).toEqual(["build", "test", "lint", "docs", "e2e", "bench"]);
	expect(pick({ tier: "release", changed: null })).toEqual(["build", "publish"]);
});

test("a change to quest.toml or an invalidate_all path picks every task of the tier", () => {
	expect(pick({ changed: ["quest.toml"] })).toEqual(["build", "test", "lint", "docs"]);
	expect(pick({ changed: ["flake.lock"] })).toEqual(["build", "test", "lint", "docs"]);
});

test("a task runs only for the operating systems it lists", () => {
	expect(pick({ tier: "gate", changed: null, os: ["macos"] })).toEqual(["build", "test", "lint", "docs"]);
	expect(pick({ tier: "gate", changed: null, os: ["windows"] })).toEqual([]);
});

test("only runs the named tasks whatever their tier or the change, with what they run after", () => {
	expect(pick({ only: ["publish", "bench"] })).toEqual(["build", "bench", "publish"]);
	expect(() => pick({ only: ["nope"] })).toThrow("quest.toml declares no task named nope");
	expect(() => pick({ only: ["e2e"], os: ["macos"] })).toThrow("task e2e runs only on linux");
});
