// `quest run`: the tasks a repository's quest.toml declares, picked for a tier and a change, each through
// `quest gate` and, for a Nix task, in the repository's dev shell, with every task whose `after` tasks passed
// running at once.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	type Host,
	MANIFEST_FILE,
	type Manifest,
	type ManifestTask,
	type TaskTier,
	parseQuestManifest,
	pickTasks,
} from "../core";
import { git } from "./git";
import { GROUP, cancelled, follow, interrupts, requested } from "./interrupt";
import { programCommand, requireProgram } from "./program";

/** What `quest run` was asked for. */
export interface RunOptions {
	/** A directory in the repository. */
	root: string;
	tier: TaskTier;
	/** Pick every task of the tier, with no base. */
	all: boolean;
	/** Run these tasks whatever their tier or the change, or null to pick by tier. */
	only: string[] | null;
	/** The ref to diff against, or undefined for `$QUEST_LAND_BASE`, then `origin/<[repo] merge>`. */
	base: string | undefined;
	os: Host[];
	/** Stop every task at the first failure. */
	failFast: boolean;
	/** Print the picked tasks as JSON instead of running them. */
	query: boolean;
	/** The directory to copy each task's JUnit XML and metrics into, or undefined. */
	report: string | undefined;
}

/** Where `quest run` writes, what it runs with, and its clock. */
export interface RunIO {
	stdout(text: string): void;
	stderr(text: string): void;
	env: NodeJS.ProcessEnv;
	now(): number;
}

/** The operating system `platform` names, as a manifest's `os` writes it. */
export function nativeOs(platform: NodeJS.Platform = process.platform): Host {
	if (platform === "linux") return "linux";
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	throw new Error(`quest run supports linux, macos, and windows, not ${platform}`);
}

/**
 * A file at a repository's root as the checks read it, from a working tree or a commit alike: its text, a symlink,
 * or null when there is none.
 */
export type RootFile = { kind: "file"; text: string } | { kind: "link" } | null;

/** How to read a file at the root of the working tree at `top`, without following a symlink. */
export function workingTree(top: string): (path: string) => RootFile {
	return (path) => {
		const file = join(top, path);
		const stat = lstatSync(file, { throwIfNoEntry: false });
		if (stat === undefined) return null;
		if (stat.isSymbolicLink()) return { kind: "link" };
		return { kind: "file", text: readFileSync(file, "utf8") };
	};
}

/** The manifest `read` finds, and every problem with it; a symlinked one, which a commit holds only as its target's path, is one. */
function parseRoot(read: (path: string) => RootFile): { manifest: Manifest | null; problems: string[] } | null {
	const file = read(MANIFEST_FILE);
	if (file === null) return null;
	if (file.kind === "link")
		return { manifest: null, problems: [`${MANIFEST_FILE}: must be a regular file, not a symlink`] };
	const parsed = parseQuestManifest(file.text);
	return parsed.ok ? { manifest: parsed.manifest, problems: [] } : { manifest: null, problems: parsed.problems };
}

/** The working tree's manifest, failing with every problem it has. */
function readManifest(top: string): Manifest {
	const parsed = parseRoot(workingTree(top));
	if (parsed === null) throw new Error(`no ${MANIFEST_FILE} at ${top}`);
	if (parsed.manifest === null) throw new Error(parsed.problems.join("\n"));
	return parsed.manifest;
}

/**
 * Why `tasks` cannot run with the root flake.nix `read` finds: Nix tasks need one, as a regular file, since a commit
 * holds a symlink only as its target's path and a dangling one is no flake.
 */
function flakeProblem(read: (path: string) => RootFile, tasks: ManifestTask[]): string | null {
	const nix = tasks.filter((task) => task.nix).map((task) => task.name);
	if (nix.length === 0) return null;
	const flake = read("flake.nix");
	if (flake?.kind === "file") return null;
	const missing = flake === null ? "there is no flake.nix" : "flake.nix is a symlink, not a regular file";
	return `${MANIFEST_FILE}: ${nix.join(", ")} run in the Nix dev shell, but ${missing}; set nix = false on a task that runs without Nix`;
}

/** What `quest check` and `quest merge` report about a repository's quest.toml, if it has one, read with `read`. */
export function manifestProblems(read: (path: string) => RootFile): string[] {
	const parsed = parseRoot(read);
	if (parsed === null) return [];
	if (parsed.manifest === null) return parsed.problems;
	const problem = flakeProblem(read, parsed.manifest.tasks);
	return problem === null ? [] : [problem];
}

/**
 * The variable a repository's dev shell sets to its root. `IN_NIX_SHELL` alone cannot tell this repository's dev
 * shell from another's, whose toolchain would then run the task.
 */
export const DEV_SHELL = "QUEST_DEV_SHELL";

/** Whether `env` is a dev shell entered for the repository at `top`. */
function inDevShell(env: NodeJS.ProcessEnv, top: string): boolean {
	const shell = env[DEV_SHELL];
	if (!shell) return false;
	try {
		return realpathSync(shell) === realpathSync(top);
	} catch {
		return false;
	}
}

/** The merge base of `ref` and HEAD, and every path changed since, tracked or untracked, both sides of a rename. */
function changes(top: string, ref: string): { base: string; changed: string[] } {
	let base: string;
	try {
		base = git(top, ["merge-base", ref, "HEAD"]);
	} catch (error) {
		throw new Error(
			`cannot find the merge base of ${ref} and HEAD; fetch its history or pass --base: ${(error as Error).message}`,
		);
	}
	const paths = (args: string[]) => git(top, args).split("\0").filter(Boolean);
	const changed = new Set([
		...paths(["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", base]),
		...paths(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return { base, changed: [...changed].sort() };
}

/** Run, or with `query` print, the tasks `options` picks, returning the exit status. */
export async function run(options: RunOptions, io: RunIO): Promise<number> {
	const top = git(options.root, ["rev-parse", "--show-toplevel"]);
	const manifest = readManifest(top);
	let base: string | null = null;
	let changed: string[] | null = null;
	if (!options.all) {
		const ref = options.base ?? (io.env.QUEST_LAND_BASE || `origin/${manifest.repo.merge}`);
		({ base, changed } = changes(top, ref));
		io.stderr(`quest: base ${ref} (${base.slice(0, 12)}), ${changed.length} changed paths\n`);
	}
	const pick = (os: Host[], only: string[] | null) => pickTasks(manifest, { tier: options.tier, only, changed, os });
	// Checks --only against every requested operating system at once.
	const tasks = pick(options.os, options.only);

	if (options.query) {
		// Each operating system picks its own tasks, and what they run after.
		const include = options.os.flatMap((os) => {
			const here = (name: string) => manifest.tasks.some((task) => task.name === name && task.os.includes(os));
			return pick([os], options.only?.filter(here) ?? null).map((task) => ({
				task: task.name,
				os,
				tier: task.tier,
				after: task.after,
				nix: task.nix,
				capabilities: task.capabilities,
				caches: task.caches,
			}));
		});
		io.stdout(`${JSON.stringify({ include })}\n`);
		return 0;
	}
	// A task runs on this host, so another operating system's tasks would run with the wrong toolchain and pass for
	// that system's; only --query, which runs nothing, lists them.
	const host = nativeOs();
	const foreign = options.os.filter((os) => os !== host);
	if (foreign.length > 0)
		throw new Error(
			`quest run executes only this host's (${host}) tasks, not ${foreign.map((os) => `${os}'s`).join(" or ")}; --query lists any operating system's`,
		);
	if (tasks.length === 0) {
		io.stderr("quest: no task to run\n");
		return 0;
	}

	// Every program is found before any task starts, so a missing one fails the run rather than one task.
	const problem = flakeProblem(workingTree(top), tasks);
	if (problem !== null) throw new Error(problem);
	// This repository's dev shell, already entered, runs Nix tasks directly with no evaluation.
	const enter = tasks.some((task) => task.nix) && !inDevShell(io.env, top);
	const programs = {
		quest: requireProgram("quest", io.env),
		bash: requireProgram("bash", io.env),
		nix: enter ? requireProgram("nix", io.env) : null,
	};
	// Sets the environment of a task run outside `nix develop`, whose dev shell has its own `env`. It runs by name,
	// since a multi-call coreutils, which its resolved path can be, picks the tool by the name it runs as.
	if (tasks.some((task) => Object.keys(task.environment).length > 0 && !(task.nix && enter)))
		requireProgram("env", io.env);
	// A directory this run creates, so no other run's or earlier run's report passes for this one's, and nothing
	// else is touched; creating it is atomic, so two runs cannot share it.
	const report = options.report === undefined ? null : resolve(options.report);
	if (report !== null) {
		mkdirSync(dirname(report), { recursive: true });
		try {
			mkdirSync(report);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			throw new Error(`--report ${options.report} already exists; name a new directory`);
		}
	}
	const env: NodeJS.ProcessEnv = { ...io.env, QUEST_TIER: options.tier };
	if (base !== null) env.QUEST_BASE = base;
	else delete env.QUEST_BASE;
	// Each task's gate leads a process group of its own, out of reach of a terminal's or an enclosing owner's group
	// signals, and this run stands in for them as Quest's group owner does (see `GROUP`): it signals the whole group,
	// so a gate whose enclosing owner holds its command, which then passes on nothing, still stops. Windows has no
	// process groups; its console delivers Ctrl-C to every process.
	const detached = process.platform !== "win32";
	if (detached) env[GROUP] = "1";

	const width = Math.max(...tasks.map((task) => task.name.length));
	const command = (task: ManifestTask): string[] => {
		// The environment applies inside the dev shell, so the gate and Nix keep the caller's PATH, and before the
		// task's Bash starts, so it reads a BASH_ENV the task sets. `env` sets it, since a launcher Bash would run an
		// inherited BASH_ENV a second time.
		const script = ["-eo", "pipefail", "-c", task.run];
		const variables = Object.entries(task.environment).map(([name, value]) => `${name}=${value}`);
		const launch = variables.length === 0 ? [] : ["env", ...variables];
		if (task.nix && programs.nix !== null)
			return [programs.nix, "develop", top, "--command", ...launch, "bash", ...script];
		return [...launch, programs.bash, ...script];
	};

	const outcomes = new Map<string, Outcome>();
	const running = new Map<string, ChildProcess>();
	let stopping = false;
	const cancel = interrupts();
	/** Signal every task: each gate's whole process group, or on Windows end the gate, whose job ends the rest. */
	const signalAll = (signal: NodeJS.Signals) => {
		for (const child of running.values()) {
			if (!detached || child.pid === undefined) child.kill(signal);
			else
				try {
					process.kill(-child.pid!, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
		}
	};
	// As a group owner, the first signal goes to every group and a second kills them. A nested gate leaves that kill
	// to this run, since its command is in its group; an outermost one owns its command in a group or scope of its
	// own, which it kills at its own second signal, so it gets the signal again instead.
	const nested = io.env.QUEST_GATE_ADMITTED === "1";
	const unfollow = follow(
		cancel,
		() => {
			stopping = true;
			if (detached) signalAll(requested(cancel.signal));
		},
		() => {
			if (detached) signalAll(nested ? "SIGKILL" : requested(cancel.signal));
		},
	);
	// Another run in this checkout would delete or overwrite the same report files mid-task, so its reports would
	// pass for this run's; this run holds the report paths of the tasks it picked until they end.
	const release = holdReports(
		top,
		tasks.flatMap((task) => declared(task).map((output) => output.path)),
	);
	try {
		await new Promise<void>((done) => {
			const schedule = () => {
				for (const task of tasks) {
					if (outcomes.has(task.name) || running.has(task.name)) continue;
					const before = task.after.map((name) => outcomes.get(name));
					const blocker = task.after.find((name) => {
						const outcome = outcomes.get(name);
						return outcome !== undefined && outcome !== "passed";
					});
					if (blocker !== undefined) {
						outcomes.set(task.name, "skipped");
						io.stderr(`quest: ${task.name} skipped, since ${blocker} did not pass\n`);
					} else if (!stopping && before.every((outcome) => outcome === "passed")) start(task);
				}
				if (running.size === 0) done();
			};
			/** Record how `task` ended, which `schedule` then acts on. */
			const finish = (task: ManifestTask, outcome: Outcome, line: string) => {
				outcomes.set(task.name, outcome);
				io.stderr(`quest: ${task.name} ${outcome}${line}\n`);
				if (outcome === "failed" && options.failFast && !stopping) {
					stopping = true;
					signalAll("SIGTERM");
				}
			};
			const start = (task: ManifestTask) => {
				const outputs = declared(task);
				try {
					for (const { path } of outputs) rmSync(join(top, path), { force: true });
				} catch (error) {
					finish(task, "failed", `: cannot remove an earlier report: ${(error as Error).message}`);
					return;
				}
				const started = io.now();
				const argv = programCommand(programs.quest, ["gate", ...command(task)], io.env);
				io.stderr(`quest: ${task.name} started\n`);
				const child = spawn(argv.file, argv.args, {
					cwd: top,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					detached,
					windowsVerbatimArguments: argv.windowsVerbatimArguments,
				});
				running.set(task.name, child);
				const prefix = `${task.name.padEnd(width)} | `;
				const lines = [prefixed(prefix, child.stdout!, io.stdout), prefixed(prefix, child.stderr!, io.stderr)];
				let failure: string | null = null;
				child.on("error", (error) => {
					failure = error.message;
				});
				child.on("close", (code, signal) => {
					for (const flush of lines) flush();
					running.delete(task.name);
					const seconds = ((io.now() - started) / 1000).toFixed(1);
					const status = failure ?? (code === 0 ? null : `exit ${code ?? signal}`);
					let problems: string[];
					try {
						problems = collect(top, task, outputs, status === null, report);
					} catch (error) {
						problems = [`cannot collect its reports: ${(error as Error).message}`];
					}
					if (status === null && problems.length === 0) finish(task, "passed", ` in ${seconds}s`);
					else {
						const why = [...(status === null ? [] : [status]), ...problems].join("; ");
						finish(task, stopping && status !== null ? "cancelled" : "failed", ` in ${seconds}s: ${why}`);
					}
					schedule();
				});
			};
			schedule();
		});
	} finally {
		release();
		unfollow();
		cancel.close();
	}

	const counts = new Map<Outcome, number>();
	for (const task of tasks) {
		const outcome = outcomes.get(task.name) ?? "skipped";
		counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	}
	io.stderr(
		`quest: ${OUTCOMES.flatMap((each) => (counts.has(each) ? [`${counts.get(each)} ${each}`] : [])).join(", ")}\n`,
	);
	if (cancel.signal.aborted) return cancelled(cancel.signal);
	return counts.has("failed") || counts.has("cancelled") ? 1 : 0;
}

const OUTCOMES = ["passed", "failed", "cancelled", "skipped"] as const;
type Outcome = (typeof OUTCOMES)[number];

/** The reports `task` declares, each with the name `--report` gives its copy. */
function declared(task: ManifestTask): { path: string; name: string }[] {
	return [
		...(task.junit === null ? [] : [{ path: task.junit, name: "junit.xml" }]),
		...(task.metrics === null ? [] : [{ path: task.metrics, name: "metrics.json" }]),
	];
}

/**
 * Check the reports a task wrote and copy them under `report`, returning what is wrong: a passing task must write
 * every report it declares, and a metrics file must hold a JSON object.
 */
function collect(
	top: string,
	task: ManifestTask,
	outputs: { path: string; name: string }[],
	passed: boolean,
	report: string | null,
): string[] {
	const problems: string[] = [];
	for (const { path, name } of outputs) {
		const file = join(top, path);
		if (!existsSync(file)) {
			if (passed) problems.push(`it did not write ${path}`);
			continue;
		}
		if (name === "metrics.json") {
			let metrics: unknown;
			try {
				metrics = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				metrics = undefined;
			}
			if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics))
				problems.push(`${path} is not a JSON object`);
		}
		if (report !== null) {
			mkdirSync(join(report, task.name), { recursive: true });
			copyFileSync(file, join(report, task.name, name));
		}
	}
	return problems;
}

/** Write each line `stream` carries with `prefix`, returning the function that writes a last unterminated line. */
function prefixed(prefix: string, stream: NodeJS.ReadableStream, write: (text: string) => void): () => void {
	let rest = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		const lines = (rest + chunk).split("\n");
		rest = lines.pop()!;
		for (const line of lines) write(`${prefix}${line}\n`);
	});
	return () => {
		if (rest !== "") write(`${prefix}${rest}\n`);
		rest = "";
	};
}

/**
 * Claim `paths`, each a report path from the repository root, for this process until the returned function releases
 * them. A claim is a file under the checkout's git directory naming its process; one whose process has exited is
 * stale and taken over. Paths compare without case, as macOS and Windows checkouts name files.
 */
function holdReports(top: string, paths: string[]): () => void {
	const dir = resolve(top, git(top, ["rev-parse", "--git-path", "quest-run-reports"]));
	mkdirSync(dir, { recursive: true });
	const held: string[] = [];
	const release = () => {
		for (const file of held.splice(0))
			try {
				if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file, { force: true });
			} catch {
				// Already gone.
			}
	};
	try {
		for (const path of [...new Set(paths.map((path) => path.toLowerCase()))].sort()) {
			const file = join(dir, createHash("sha256").update(path).digest("hex").slice(0, 32));
			for (let attempt = 0; ; attempt++) {
				try {
					writeFileSync(file, String(process.pid), { flag: "wx" });
					held.push(file);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
				}
				const owner = Number(readFileSync(file, "utf8"));
				if (alive(owner))
					throw new Error(
						`another quest run in this checkout is writing ${paths.find((each) => each.toLowerCase() === path)} (process ${owner}); wait for it to finish`,
					);
				rmSync(file, { force: true });
			}
		}
	} catch (error) {
		release();
		throw error;
	}
	return release;
}

/** Whether process `pid` still runs; EPERM means it runs as another user. */
function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
