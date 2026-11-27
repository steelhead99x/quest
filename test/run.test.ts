// quest run: picking tasks from a change, running them in their order through the gate and the Nix dev shell,
// and collecting their reports.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { main } from "../src/cli/main";
import { REFERENCE_LINE } from "../src/core";
import { type RunOptions, nativeOs, run } from "../src/cli/run";
import { initRepository, tempDir } from "./fixture";

// The stubs are shell scripts.
const posix = process.platform !== "win32";

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** A repository on main holding `files`, with `origin/main` at that commit. */
function repository(files: Record<string, string>): string {
	const dir = initRepository(tempDir());
	write(dir, files);
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/main", "HEAD"], { stdio: "ignore" });
	return dir;
}

function write(dir: string, files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
}

/**
 * A PATH directory with a `quest` whose gate runs its command at once and a `nix` whose `develop <flake> --command`
 * runs its command in a dev shell, each logging its arguments.
 */
function stubs(): { bin: string; log: string } {
	const bin = tempDir();
	const log = join(bin, "log");
	const script = (body: string) => `#!/bin/sh\necho "$(basename "$0") $*" >> ${quote(log)}\n${body}\n`;
	writeFileSync(join(bin, "quest"), script('[ "$1" = gate ] || exit 99\nshift\nexec "$@"'), { mode: 0o755 });
	writeFileSync(
		join(bin, "nix"),
		script('[ "$1" = develop ] && [ "$3" = --command ] || exit 98\nshift 3\nIN_NIX_SHELL=impure exec "$@"'),
		{ mode: 0o755 },
	);
	return { bin, log };
}

/** A PATH directory whose `quest` runs this checkout's CLI, for the real gate. */
function realQuest(): string {
	const bin = tempDir();
	const entry = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
	const config = fileURLToPath(new URL("../bunfig.toml", import.meta.url));
	writeFileSync(
		join(bin, "quest"),
		`#!/bin/sh\nexec ${quote(process.execPath)} --config=${quote(config)} ${quote(entry)} "$@"\n`,
		{ mode: 0o755 },
	);
	return bin;
}

const task = (name: string, script: string, extra = "") =>
	`[tasks.${name}]\ntier = "pr"\nrun = ${JSON.stringify(script)}\nnix = false\n${extra}\n`;

async function runIn(
	dir: string,
	options: Partial<RunOptions> = {},
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string; log: string[] }> {
	const { bin, log } = stubs();
	let stdout = "";
	let stderr = "";
	const code = await run(
		{
			root: dir,
			tier: "pr",
			all: false,
			only: null,
			base: undefined,
			os: [nativeOs()],
			failFast: false,
			query: false,
			report: undefined,
			...options,
		},
		{
			stdout: (text) => void (stdout += text),
			stderr: (text) => void (stderr += text),
			env: { PATH: `${bin}:${process.env.PATH}`, ...env },
			now: () => 0,
		},
	);
	const logged = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
	return { code, stdout, stderr, log: logged };
}

test.runIf(posix)("a task starts once those it runs after pass, and independent tasks start at once", async () => {
	const dir = repository({
		"quest.toml": [
			task("build", "touch built; echo built"),
			task("test", "test -f built; echo tested", 'after = ["build"]'),
			task("lint", "echo linted"),
		].join(""),
	});
	const out = await runIn(dir, { all: true });
	expect(out.code, out.stderr).toBe(0);
	expect(out.stdout.split("\n").sort()).toEqual(["", "build | built", "lint  | linted", "test  | tested"]);
	const events = out.stderr.split("\n").filter((line) => / (started|passed)/.test(line));
	// build and lint start together; test waits for build.
	expect(events.slice(0, 2)).toEqual(["quest: build started", "quest: lint started"]);
	expect(events.indexOf("quest: test started")).toBeGreaterThan(events.indexOf("quest: build passed in 0.0s"));
	expect(out.stderr).toContain("quest: 3 passed\n");
	// Every task runs through the gate.
	expect(out.log.filter((line) => line.startsWith("quest gate "))).toHaveLength(3);
});

test.runIf(posix)("a failed task skips those after it while the others finish, and fails the run", async () => {
	const dir = repository({
		"quest.toml": [
			task("build", "exit 3"),
			task("test", "echo never", 'after = ["build"]'),
			task("e2e", "echo never", 'after = ["test"]'),
			task("lint", "echo linted"),
		].join(""),
	});
	const out = await runIn(dir, { all: true });
	expect(out.code).toBe(1);
	expect(out.stdout).toBe("lint  | linted\n");
	expect(out.stderr).toContain("quest: build failed in 0.0s: exit 3\n");
	expect(out.stderr).toContain("quest: test skipped, since build did not pass\n");
	expect(out.stderr).toContain("quest: e2e skipped, since test did not pass\n");
	expect(out.stderr).toContain("quest: 1 passed, 1 failed, 2 skipped\n");
});

test.runIf(posix)("fail-fast stops the running tasks and starts no more", async () => {
	const dir = repository({
		"quest.toml": [
			task("slow", "exec sleep 300"),
			task("broken", "exit 1"),
			task("after", "echo never", 'after = ["broken", "slow"]'),
		].join(""),
	});
	const out = await runIn(dir, { all: true, failFast: true });
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("quest: slow cancelled in 0.0s: exit SIGTERM\n");
	expect(out.stderr).toContain("quest: 1 failed, 1 cancelled, 1 skipped\n");
});

// Under an enclosing gate, whose group owner signals its whole process group, a task's own gate passes on no
// signal it receives: fail-fast must still reach the command. The real gate, admitted at once.
test.runIf(posix)("fail-fast stops a task's command under an enclosing gate", async () => {
	// broken fails only once slow's gate runs its command, which the gate's signal handling then covers.
	const fifo = join(tempDir(), "started");
	execFileSync("mkfifo", [fifo]);
	const dir = repository({
		"quest.toml": [
			task("slow", `echo > ${quote(fifo)}; exec sleep 300`),
			task("broken", `read -r _ < ${quote(fifo)}; exit 1`),
		].join(""),
	});
	const out = await runIn(
		dir,
		{ all: true, failFast: true },
		{ PATH: `${realQuest()}:${process.env.PATH}`, QUEST_GATE_ADMITTED: "1", QUEST_GATE_GROUP: "1" },
	);
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("quest: slow cancelled in 0.0s: exit 143\n");
});

test.runIf(posix)("tasks get the tier, the merge base, and their environment inside the shell", async () => {
	const dir = repository({
		"quest.toml": task(
			"env",
			'echo "$QUEST_TIER $QUEST_BASE $FOO $PATH $(greet)"',
			`environment = { FOO = "it's", PATH = "/elsewhere", BASH_ENV = "setup.sh" }`,
		),
		// The task's Bash reads it as it starts.
		"setup.sh": "greet() { echo hello; }\n",
	});
	const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	write(dir, { "new.txt": "untracked" });
	// The gate still finds its programs on the caller's PATH; the task sees its own.
	const out = await runIn(dir, { tier: "gate" });
	expect(out.stdout).toBe(`env | gate ${base} it's /elsewhere hello\n`);
	expect(out.stderr).toContain(`quest: base origin/main (${base.slice(0, 12)}), 1 changed paths\n`);
	// Setting the environment starts no other Bash, which would run an inherited BASH_ENV a second time, in or
	// out of the dev shell.
	const counter = join(tempDir(), "count");
	const startup = join(tempDir(), "startup.sh");
	writeFileSync(startup, `echo ran >> ${quote(counter)}\n`);
	const once = repository({
		"flake.nix": "{}",
		"quest.toml": `${task("plain", 'echo "$FOO"', 'environment = { FOO = "bar" }')}[tasks.nixed]\ntier = "pr"\nrun = 'echo "$FOO"'\nenvironment = { FOO = "baz" }\n`,
	});
	const inherited = await runIn(once, { all: true }, { BASH_ENV: startup });
	expect(inherited.stdout.split("\n").sort()).toEqual(["", "nixed | baz", "plain | bar"]);
	expect(inherited.log).toContain(`nix develop ${once} --command env FOO=baz bash -eo pipefail -c echo "$FOO"`);
	expect(readFileSync(counter, "utf8")).toBe("ran\nran\n");
	// --all sets no base, even one a run around this one set.
	expect((await runIn(dir, { all: true }, { QUEST_BASE: "outer" })).stdout).toBe("env | pr  it's /elsewhere hello\n");
});

test.runIf(posix)("the base is --base, else QUEST_LAND_BASE, else origin and [repo] merge", async () => {
	const dir = repository({
		"quest.toml": `[repo]\nmerge = "trunk"\n${task("a", "echo a", 'paths = ["a/"]')}${task("b", "echo b", 'paths = ["b/"]')}`,
	});
	execFileSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/trunk", "HEAD"], { stdio: "ignore" });
	write(dir, { "a/x": "1" });
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "a"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "tag", "after-a"], { stdio: "ignore" });
	write(dir, { "b/x": "1" });
	// origin/trunk is before both changes.
	expect((await runIn(dir)).stdout.split("\n").sort()).toEqual(["", "a | a", "b | b"]);
	expect((await runIn(dir, {}, { QUEST_LAND_BASE: "after-a" })).stdout).toBe("b | b\n");
	expect((await runIn(dir, { base: "after-a" }, { QUEST_LAND_BASE: "origin/trunk" })).stdout).toBe("b | b\n");
	const missing = runIn(dir, { base: "nowhere" });
	await expect(missing).rejects.toThrow("cannot find the merge base of nowhere and HEAD");
});

test.runIf(posix)("query prints one matrix entry per task and operating system and runs nothing", async () => {
	const dir = repository({
		"flake.nix": "{}",
		"quest.toml": [
			'[tasks.build]\ntier = "pr"\nrun = "touch ran"\ncaches = ["mbx"]\n',
			'[tasks.test]\ntier = "gate"\nrun = "touch ran"\nafter = ["build"]\nos = ["linux"]\ncapabilities = ["kvm"]\n',
		].join(""),
	});
	const out = await runIn(dir, { tier: "gate", all: true, query: true, os: ["linux", "macos"] });
	expect(out.code).toBe(0);
	expect(JSON.parse(out.stdout)).toEqual({
		include: [
			{ task: "build", os: "linux", tier: "pr", after: [], nix: true, capabilities: [], caches: ["mbx"] },
			{ task: "test", os: "linux", tier: "gate", after: ["build"], nix: true, capabilities: ["kvm"], caches: [] },
			{ task: "build", os: "macos", tier: "pr", after: [], nix: true, capabilities: [], caches: ["mbx"] },
		],
	});
	expect(existsSync(join(dir, "ran"))).toBe(false);
	expect(out.log).toEqual([]);
});

test.runIf(posix)("query picks each operating system's tasks and what they run after on its own", async () => {
	const dir = repository({
		"quest.toml": [
			task("build", "true", 'paths = ["build/"]\nos = ["linux", "macos"]'),
			task("test", "true", 'paths = ["test/"]\nafter = ["build"]\nos = ["linux"]'),
		].join(""),
	});
	write(dir, { "test/a": "" });
	const out = await runIn(dir, { query: true, os: ["linux", "macos"] });
	// No change picks a macOS task, so the Linux test's build stays on Linux.
	expect(JSON.parse(out.stdout).include.map(({ task, os }: { task: string; os: string }) => `${task}/${os}`)).toEqual(
		["build/linux", "test/linux"],
	);
	const only = await runIn(dir, { query: true, os: ["linux", "macos"], only: ["test"] });
	expect(JSON.parse(only.stdout).include).toHaveLength(2);
});

test.runIf(posix)(
	"a Nix task enters the dev shell unless already in this repository's, and needs flake.nix",
	async () => {
		const nixTask = '[tasks.nixed]\ntier = "pr"\nrun = "echo shell=$IN_NIX_SHELL"\n';
		const dir = repository({
			"flake.nix": "{}",
			"quest.toml": nixTask + task("plain", "echo shell=$IN_NIX_SHELL"),
		});
		const outside = await runIn(dir, { all: true });
		expect(outside.code, outside.stderr).toBe(0);
		expect(outside.stdout.split("\n").sort()).toEqual(["", "nixed | shell=impure", "plain | shell="]);
		expect(outside.log).toContain(`nix develop ${dir} --command bash -eo pipefail -c echo shell=$IN_NIX_SHELL`);
		// Inside this repository's dev shell, no task calls nix.
		const inside = await runIn(dir, { all: true }, { IN_NIX_SHELL: "impure", QUEST_DEV_SHELL: dir });
		expect(inside.code).toBe(0);
		expect(inside.log.filter((line) => line.startsWith("nix "))).toEqual([]);
		// Another repository's dev shell has the wrong toolchain.
		const other = await runIn(dir, { all: true }, { IN_NIX_SHELL: "impure", QUEST_DEV_SHELL: tempDir() });
		expect(other.log.filter((line) => line.startsWith("nix "))).toHaveLength(1);

		const bare = repository({ "quest.toml": nixTask + task("plain", "echo plain") });
		await expect(runIn(bare, { all: true })).rejects.toThrow(
			"quest.toml: nixed run in the Nix dev shell, but there is no flake.nix",
		);
		symlinkSync("missing.nix", join(bare, "flake.nix"));
		await expect(runIn(bare, { all: true })).rejects.toThrow(
			"quest.toml: nixed run in the Nix dev shell, but flake.nix is a symlink, not a regular file",
		);
		rmSync(join(bare, "flake.nix"));
		// A run that picks only tasks without Nix needs neither the flake nor nix.
		const plain = await runIn(bare, { only: ["plain"] });
		expect(plain.code).toBe(0);
		expect(plain.stdout).toBe("plain | plain\n");
	},
);

test.runIf(posix)("a task's reports are checked and copied, and a stale one never counts", async () => {
	const dir = repository({
		"quest.toml": [
			task(
				"good",
				"echo '<testsuites/>' > out/good.xml; echo '{\"ms\": 1}' > out/good.json",
				'junit = "out/good.xml"\nmetrics = "out/good.json"',
			),
			task("lazy", "true", 'junit = "out/lazy.xml"'),
			task("bad", "echo '[1]' > out/bad.json", 'metrics = "out/bad.json"'),
		].join(""),
		// An earlier run's report, which lazy must not pass off as its own.
		"out/lazy.xml": "<stale/>",
	});
	// A report directory already in use, such as the checkout itself, is refused before anything runs.
	await expect(runIn(dir, { all: true, report: dir })).rejects.toThrow(`--report ${dir} already exists`);
	const report = join(tempDir(), "report");
	const out = await runIn(dir, { all: true, report });
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("quest: lazy failed in 0.0s: it did not write out/lazy.xml\n");
	expect(out.stderr).toContain("quest: bad failed in 0.0s: out/bad.json is not a JSON object\n");
	expect(readFileSync(join(report, "good", "junit.xml"), "utf8")).toBe("<testsuites/>\n");
	expect(readFileSync(join(report, "good", "metrics.json"), "utf8")).toBe('{"ms": 1}\n');
	expect(existsSync(join(report, "lazy"))).toBe(false);
});

// The real CLI and the real gate, admitted at once so a loaded host does not hold the test.
test.runIf(posix)("quest run runs a fixture repository's quest.toml end to end", async () => {
	const dir = repository({
		"quest.toml": [
			'[repo]\ninvalidate_all = ["shared/"]\n',
			task("build", "mkdir -p out; echo built > out/build", 'paths = ["src/"]'),
			task(
				"test",
				"cat out/build; echo '<testsuites/>' > out/junit.xml",
				'after = ["build"]\npaths = ["test/"]\njunit = "out/junit.xml"',
			),
			task("docs", "echo docs", 'paths = ["docs/"]'),
			task("nightly", "echo nightly", 'tier = "nightly"').replace('tier = "pr"\n', ""),
		].join(""),
	});
	write(dir, { "test/a.ts": "" });
	const bin = realQuest();
	const report = join(tempDir(), "report");
	const previous = { PATH: process.env.PATH, admitted: process.env.QUEST_GATE_ADMITTED };
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.QUEST_GATE_ADMITTED = "1";
	let stdout = "";
	let stderr = "";
	try {
		const code = await main(["--root", dir, "run", "--tier", "gate", "--os", "linux", "--report", report], {
			stdout: (text) => void (stdout += text),
			stderr: (text) => void (stderr += text),
		});
		expect(code, stderr).toBe(0);
	} finally {
		process.env.PATH = previous.PATH;
		if (previous.admitted === undefined) delete process.env.QUEST_GATE_ADMITTED;
		else process.env.QUEST_GATE_ADMITTED = previous.admitted;
	}
	// test/ picks test, which pulls in build; docs and the nightly task stay out.
	expect(stdout).toBe("test  | built\n");
	expect(stderr).toContain("quest: 2 passed\n");
	expect(readFileSync(join(report, "test", "junit.xml"), "utf8")).toBe("<testsuites/>\n");
});

test.runIf(posix)("quest check reports a malformed quest.toml, and Nix tasks without flake.nix", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	write(dir, { "AGENTS.md": `${REFERENCE_LINE}\n`, "quest/README.md": "# Quests\n\n## Goal\n\nWork.\n" });
	const check = async () => {
		let stderr = "";
		const code = await main(["--root", dir, "check", "--no-stubs"], {
			stdout: () => {},
			stderr: (text) => void (stderr += text),
		});
		return { code, stderr };
	};
	write(dir, { "quest.toml": '[tasks.a]\ntier = "pr"\n' });
	expect(await check()).toEqual({ code: 1, stderr: "quest: quest.toml: [tasks.a]: missing `run`\n" });
	write(dir, { "quest.toml": '[tasks.a]\ntier = "pr"\nrun = "x"\n' });
	expect(await check()).toEqual({
		code: 1,
		stderr: "quest: quest.toml: a run in the Nix dev shell, but there is no flake.nix; set nix = false on a task that runs without Nix\n",
	});
	// A dangling flake symlink is no flake, and a commit holds any symlink only as its target's path.
	symlinkSync("missing.nix", join(dir, "flake.nix"));
	expect(await check()).toEqual({
		code: 1,
		stderr: "quest: quest.toml: a run in the Nix dev shell, but flake.nix is a symlink, not a regular file; set nix = false on a task that runs without Nix\n",
	});
	rmSync(join(dir, "flake.nix"));
	write(dir, { "flake.nix": "{}" });
	expect((await check()).code).toBe(0);
	// A commit holds a symlink as its target's path, so quest merge could not read one; neither does quest check.
	write(dir, { "ci/tasks.toml": '[tasks.a]\ntier = "pr"\nrun = "x"\n' });
	rmSync(join(dir, "quest.toml"));
	symlinkSync("ci/tasks.toml", join(dir, "quest.toml"));
	expect(await check()).toEqual({
		code: 1,
		stderr: "quest: quest.toml: must be a regular file, not a symlink\n",
	});
});

test.runIf(posix)("refuses to run another operating system's tasks, which --query may still list", async () => {
	const other = (["linux", "macos", "windows"] as const).find((os) => os !== nativeOs())!;
	const dir = repository({ "quest.toml": task("port", "touch ran", `os = ["${other}"]`) });
	await expect(runIn(dir, { all: true, os: [other] })).rejects.toThrow(
		`quest run executes only this host's (${nativeOs()}) tasks, not ${other}'s; --query lists any operating system's`,
	);
	await expect(runIn(dir, { all: true, os: [nativeOs(), other] })).rejects.toThrow(`not ${other}'s`);
	expect(existsSync(join(dir, "ran"))).toBe(false);
	const query = await runIn(dir, { all: true, os: [other], query: true });
	expect(JSON.parse(query.stdout).include).toEqual([expect.objectContaining({ task: "port", os: other })]);
});

test.runIf(posix)("a second run in the same checkout cannot take over a running task's reports", async () => {
	// Each run writes its own name to the shared report path, then takes a while to finish.
	const dir = repository({ "quest.toml": task("unit", 'echo "$RUN" > unit.xml; sleep 1', 'junit = "unit.xml"') });
	const first = join(tempDir(), "first");
	const a = runIn(dir, { all: true, report: first }, { RUN: "a" });
	await new Promise((done) => setTimeout(done, 300));
	await expect(runIn(dir, { all: true }, { RUN: "b" })).rejects.toThrow(
		"another quest run in this checkout is writing unit.xml",
	);
	expect((await a).code).toBe(0);
	expect(readFileSync(join(first, "unit", "junit.xml"), "utf8")).toBe("a\n");
	// Once the first run ends, the next one may write the report.
	expect((await runIn(dir, { all: true }, { RUN: "b" })).code).toBe(0);
	expect(readFileSync(join(dir, "unit.xml"), "utf8")).toBe("b\n");
});

test.runIf(posix)("a claim left by a run that died is taken over", async () => {
	const dir = repository({ "quest.toml": task("unit", "echo ok > Unit.xml", 'junit = "Unit.xml"') });
	// The claim of a process that has exited, as a killed run leaves it; paths compare without case.
	const dead = spawnSync("true").pid!;
	const claims = join(dir, ".git", "quest-run-reports");
	mkdirSync(claims, { recursive: true });
	writeFileSync(join(claims, createHash("sha256").update("unit.xml").digest("hex").slice(0, 32)), String(dead));
	const out = await runIn(dir, { all: true });
	expect(out.code, out.stderr).toBe(0);
	// The run releases its claims when it ends.
	expect(execFileSync("ls", [claims], { encoding: "utf8" })).toBe("");
});
