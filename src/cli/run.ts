// `quest run`: the tasks a repository's quest.toml declares, picked for a tier and a change, each through
// `quest gate` and, for a Nix task, in the repository's dev shell, with every task whose `after` tasks passed
// running at once, and a task whose inputs this host already saw pass taking that pass instead of running.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import {
	type CargoCrate,
	type CargoWorkspace,
	DIRTY,
	type TaskResult,
	type TreeFile,
	cargoWorkspace,
	devShellDerivation,
	digest,
	inputFiles,
	taskCache,
	treeFiles,
	workspaceManifest,
} from "./task-cache";

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
	/** Take and record passes in this user's task cache; false runs every task and records nothing. */
	cache: boolean;
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

/** The working tree's manifest, or null when there is none, failing with every problem it has. */
export function rootManifest(top: string): Manifest | null {
	const parsed = parseRoot(workingTree(top));
	if (parsed === null) return null;
	if (parsed.manifest === null) throw new Error(parsed.problems.join("\n"));
	return parsed.manifest;
}

/** The working tree's manifest, failing when there is none or with every problem it has. */
function readManifest(top: string): Manifest {
	const manifest = rootManifest(top);
	if (manifest === null) throw new Error(`no ${MANIFEST_FILE} at ${top}`);
	return manifest;
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

/** The Nix binary cache Kixel Quest serves, which a repository opting in with quest.toml substitutes from. */
export const NIX_CACHE = "https://nix.kixel.quest";

/** A Nix token: a name, a string's literal text (interpolations left out), a path, or one punctuation character. */
type NixToken = { kind: "name" | "string" | "path" | "punct"; text: string };

/**
 * A path literal at the start of the text, such as `./in/default.nix`, `~/x`, or `<nixpkgs>`, or the part of an
 * interpolated one, such as `./profiles/${name}-in`, before its first `${`.
 */
const NIX_PATH = /^(?:<[\w.+/-]+>|(?:~|[\w.+-]*)(?:\/[\w.+-]+)+\/?|(?:~|[\w.+-]*)(?:\/[\w.+-]+)*\/(?=\$\{))/;

/** The tokens of Nix source outside comments; an interpolation's code yields none. */
function nixTokens(source: string): NixToken[] {
	const tokens: NixToken[] = [];
	let i = 0;
	/** Code up to the `}` that closes an interpolation, or the end; `emit` is false inside one. */
	const code = (emit: boolean, interpolation: boolean): void => {
		let depth = 0;
		while (i < source.length) {
			const c = source[i]!;
			if (/\s/.test(c)) i++;
			else if (c === "#") i = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
			else if (source.startsWith("/*", i))
				i = source.indexOf("*/", i + 2) < 0 ? source.length : source.indexOf("*/", i + 2) + 2;
			else if (c === '"' || source.startsWith("''", i)) {
				const text = string(c === '"' ? '"' : "''");
				if (emit) tokens.push({ kind: "string", text });
			} else if (NIX_PATH.test(source.slice(i, i + 4096))) {
				const start = i;
				i += NIX_PATH.exec(source.slice(i, i + 4096))![0].length;
				// An interpolated path runs on through each `${...}` and the path characters after it.
				while (source[start] !== "<" && source.startsWith("${", i)) {
					i += 2;
					code(false, true);
					i += /^[\w.+/-]*/.exec(source.slice(i, i + 4096))![0].length;
				}
				if (emit) tokens.push({ kind: "path", text: source.slice(start, i) });
			} else if (/[A-Za-z_]/.test(c)) {
				const name = /^[A-Za-z_][\w'-]*/.exec(source.slice(i))![0];
				i += name.length;
				if (emit) tokens.push({ kind: "name", text: name });
			} else {
				i++;
				if (c === "{") depth++;
				else if (c === "}" && interpolation && depth-- === 0) return;
				if (emit) tokens.push({ kind: "punct", text: c });
			}
		}
	};
	/** A string from its opening quote, returning its literal text. */
	const string = (quote: '"' | "''"): string => {
		i += quote.length;
		let text = "";
		while (i < source.length) {
			if (quote === '"' && source[i] === "\\") {
				text += source[i + 1] ?? "";
				i += 2;
			} else if (quote === "''" && /^''['$\\]/.test(source.slice(i, i + 3))) {
				text += source[i + 2];
				i += 3;
			} else if (source.startsWith(quote, i)) {
				i += quote.length;
				return text;
			} else if (source.startsWith("${", i)) {
				i += 2;
				code(false, true);
			} else text += source[i++];
		}
		return text;
	};
	code(true, false);
	return tokens;
}

/**
 * The substituters flake.nix's `nixConfig` lists under `substituters` and `extra-substituters`, as a block or dotted
 * keys and as lists or space-separated strings. Nix reads `nixConfig` only at the top of the file's attribute set, so
 * one anywhere else counts for nothing.
 */
function substituters(flake: string): string[] {
	const tokens = nixTokens(flake);
	let p = 0;
	const at = (text: string) => tokens[p]?.kind === "punct" && tokens[p]!.text === text;
	/**
	 * Skip a binding's value through its `;`, over every bracket, `let` ... `in`, and each `with` or `assert` and the
	 * `;` that ends it at its own depth.
	 */
	const skip = () => {
		const pending: number[] = [];
		for (let depth = 0; p < tokens.length; p++) {
			const { kind, text } = tokens[p]!;
			if (kind === "name") {
				if (text === "let") depth++;
				else if (text === "in") depth--;
				else if (text === "with" || text === "assert") pending.push(depth);
			} else if (kind === "punct") {
				if ("{[(".includes(text)) depth++;
				else if ("}])".includes(text)) depth--;
				else if (text === ";" && pending.at(-1) === depth) pending.pop();
				else if (text === ";" && depth === 0) break;
			}
		}
		p++;
	};
	/** A binding's attribute path through its `=`, or null for anything else, such as `inherit`. */
	const path = (): string[] | null => {
		const names: string[] = [];
		while (tokens[p]?.kind === "name" || tokens[p]?.kind === "string") {
			names.push(tokens[p++]!.text);
			if (!at(".")) break;
			p++;
		}
		if (names.length === 0 || names[0] === "inherit" || !at("=")) return null;
		p++;
		return names;
	};
	const found: string[] = [];
	/** A setting's value, if it is a substituter list, then the rest of its binding. */
	const setting = (key: string | undefined) => {
		if (key === "substituters" || key === "extra-substituters") {
			if (tokens[p]?.kind === "string") found.push(...tokens[p]!.text.split(/\s+/));
			else if (at("[")) {
				for (p++; p < tokens.length && !at("]"); p++)
					if (tokens[p]!.kind === "string") found.push(tokens[p]!.text);
				p++;
			}
		}
		skip();
	};
	if (!at("{")) return found;
	p++;
	while (p < tokens.length && !at("}")) {
		const names = path();
		if (names === null) skip();
		else if (names[0] !== "nixConfig") skip();
		else if (names.length > 1) setting(names[1]);
		else if (!at("{")) skip();
		else {
			p++;
			while (p < tokens.length && !at("}")) {
				const inner = path();
				if (inner === null) skip();
				else setting(inner[0]);
			}
			p++;
			skip();
		}
	}
	return found;
}

/** Why `flake` does not substitute from Kixel Quest's cache, or null when its `nixConfig` lists it. */
function cacheProblem(flake: string): string | null {
	if (substituters(flake).some((url) => url.replace(/\/$/, "") === NIX_CACHE)) return null;
	return `${MANIFEST_FILE}: the repository opts into Kixel Quest, so flake.nix's nixConfig must list ${NIX_CACHE} in extra-substituters`;
}

/**
 * What `quest check` and `quest merge` report about a repository's quest.toml, if it has one, read with `read`. A
 * quest.toml opts the repository into Kixel Quest, which needs Nix: a regular root flake.nix substituting from its
 * cache, even when every task sets `nix = false`.
 */
export function manifestProblems(read: (path: string) => RootFile): string[] {
	const parsed = parseRoot(read);
	if (parsed === null) return [];
	if (parsed.manifest === null) return parsed.problems;
	const flake = read("flake.nix");
	if (flake?.kind !== "file") {
		const missing = flake === null ? "there is no flake.nix" : "flake.nix is a symlink, not a regular file";
		return [`${MANIFEST_FILE}: the repository opts into Kixel Quest, which needs Nix, but ${missing} at its root`];
	}
	const cache = cacheProblem(flake.text);
	return cache === null ? [] : [cache];
}

/**
 * The variable a repository's dev shell sets to its root. `IN_NIX_SHELL` alone cannot tell this repository's dev
 * shell from another's, whose toolchain would then run the task.
 */
export const DEV_SHELL = "QUEST_DEV_SHELL";

/** Whether `env` is a dev shell entered for the repository at `top`. */
export function inDevShell(env: NodeJS.ProcessEnv, top: string): boolean {
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
	if (tasks.length === 0) {
		io.stderr("quest: no task to run\n");
		return 0;
	}

	// Every program is found before any task starts, so a missing one fails the run rather than one task.
	const problem = flakeProblem(workingTree(top), tasks);
	if (problem !== null) throw new Error(problem);
	const caching = options.cache && tasks.some((task) => task.cache);
	// The cache fingerprints the flake's dev shell with Nix even from inside a dev shell.
	const fingerprint = caching && tasks.some((task) => task.nix);
	// This repository's dev shell, already entered, runs Nix tasks directly with no evaluation, except while the cache
	// is in use: the entered shell may predate an edit to the flake, so every Nix task, a cached one's prerequisites
	// included, runs in the shell the digests name.
	const develop = (task: ManifestTask) => task.nix && (caching || !inDevShell(io.env, top));
	const programs = {
		quest: requireProgram("quest", io.env),
		bash: requireProgram("bash", io.env),
		nix: tasks.some(develop) || fingerprint ? requireProgram("nix", io.env) : null,
	};
	// Sets the environment of a task run outside `nix develop`, whose dev shell has its own `env`. It runs by name,
	// since a multi-call coreutils, which its resolved path can be, picks the tool by the name it runs as.
	if (tasks.some((task) => Object.keys(task.environment).length > 0 && !develop(task))) requireProgram("env", io.env);

	// A Cargo task runs once per crate, in the dev shell's Cargo for a Nix task. Every feature is on, so each crate's
	// closure holds the optional dependencies a task's own feature flags may build.
	let workspace: CargoWorkspace | null = null;
	const cargo = tasks.find((task) => task.cargo);
	if (cargo !== undefined) {
		const metadata = ["cargo", "metadata", "--locked", "--all-features", "--format-version", "1"];
		const argv = develop(cargo)
			? [programs.nix!, "develop", top, "--command", ...metadata]
			: [requireProgram("cargo", io.env), ...metadata.slice(1)];
		const result = spawnSync(argv[0]!, argv.slice(1), {
			cwd: top,
			env: io.env,
			encoding: "utf8",
			maxBuffer: 1 << 30,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`cargo metadata --locked failed:\n${result.stderr.trim()}`);
		// A dev shell's hook may print before Cargo's one line of JSON.
		workspace = cargoWorkspace(result.stdout.trim().split("\n").pop()!, top);
	}
	const units = tasks.flatMap<Unit>((task) =>
		task.cargo
			? workspace!.crates.map((crate) => ({ task, crate, name: `${task.name}:${crate.name}`, digest: null }))
			: [{ task, crate: null, name: task.name, digest: null }],
	);

	const cache = caching ? taskCache(io.env) : null;
	const hits = new Map<Unit, TaskResult>();
	/** The digest of everything `unit` reads in `files`, or why no digest can name it, while the run uses the cache. */
	let digestOf: ((unit: Unit, files: TreeFile[]) => { digest: string } | { uncached: string }) | null = null;
	if (cache !== null) {
		const shell = fingerprint ? devShellDerivation(programs.nix!, top, io.env) : null;
		const cargoManifest = workspace === null ? null : readFileSync(join(top, "Cargo.toml"), "utf8");
		digestOf = (unit, files) => {
			const { task, crate } = unit;
			const read = inputFiles(
				task,
				files,
				manifest.repo.invalidateAll,
				crate === null ? null : { crate, workspace: workspace! },
			);
			// Tasks come after those they run after, whose digests each covers, since it may read what they wrote.
			const before = units.filter((each) => task.after.includes(each.task.name));
			const after = before.map((each) => each.digest);
			if (read.some((file) => file.oid === DIRTY))
				return { uncached: "it reads a submodule with uncommitted changes" };
			if (crate !== null && crate.unlisted.length > 0)
				return {
					uncached: `cargo metadata lists no crate at ${crate.unlisted.join(", ")}, a path dependency it may build`,
				};
			const uncachedBefore = before.find((each) => each.digest === null);
			if (uncachedBefore !== undefined)
				return { uncached: `it runs after ${uncachedBefore.name}, whose inputs no digest names` };
			const key = digest({
				// Raised whenever the digest's material changes meaning, so no earlier pass matches.
				version: 3,
				system: `${process.arch}-${process.platform}`,
				shell: task.nix ? shell : null,
				run: task.run,
				environment: Object.entries(task.environment).sort(),
				// The caller's values for what the task declares it inherits; an unset one is distinct from an empty one.
				inherited: [...task.inherit].sort().map((name) => [name, io.env[name] ?? null]),
				junit: task.junit,
				metrics: task.metrics,
				crate:
					crate === null
						? null
						: {
								name: crate.name,
								packages: crate.packages,
								manifest: workspaceManifest(cargoManifest!, crate.names),
							},
				files: read.map((file) => [file.path, file.mode, file.oid]),
				after,
			});
			return { digest: key };
		};
		const files = treeFiles(top);
		for (const unit of units) {
			const key = digestOf(unit, files);
			unit.digest = "digest" in key ? key.digest : null;
			if (!unit.task.cache) continue;
			if ("uncached" in key) {
				io.stderr(`quest: ${unit.name} is not cached, since ${key.uncached}\n`);
				continue;
			}
			const hit = await cache.get(key.digest);
			if (hit !== undefined) hits.set(unit, hit);
		}
	}
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

	const width = Math.max(...units.map((unit) => unit.name.length));
	const command = (task: ManifestTask): string[] => {
		// The environment applies inside the dev shell, so the gate and Nix keep the caller's PATH, and before the
		// task's Bash starts, so it reads a BASH_ENV the task sets. `env` sets it, since a launcher Bash would run an
		// inherited BASH_ENV a second time.
		const script = ["-eo", "pipefail", "-c", task.run];
		const variables = Object.entries(task.environment).map(([name, value]) => `${name}=${value}`);
		const launch = variables.length === 0 ? [] : ["env", ...variables];
		if (develop(task)) return [programs.nix!, "develop", top, "--command", ...launch, "bash", ...script];
		return [...launch, programs.bash, ...script];
	};

	const outcomes = new Map<Unit, Outcome>();
	const running = new Map<Unit, ChildProcess>();
	/** How each unit that passed or ran got its outcome, for the summary: a cached pass, or its run's seconds. */
	const results = new Map<Unit, "hit" | string>();
	const writes: Promise<void>[] = [];
	let writeFailure: unknown;
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
	try {
		await new Promise<void>((done) => {
			const schedule = () => {
				for (const [index, unit] of units.entries()) {
					if (outcomes.has(unit) || running.has(unit)) continue;
					const { task } = unit;
					const before = units.filter((each) => task.after.includes(each.task.name));
					const blocker = before.find((each) => {
						const outcome = outcomes.get(each);
						return outcome !== undefined && outcome !== "passed";
					});
					// A task's crates run one at a time, since they share its reports and Cargo's build lock.
					const previous = units[index - 1]?.task === task ? units[index - 1] : undefined;
					if (blocker !== undefined) {
						outcomes.set(unit, "skipped");
						io.stderr(`quest: ${unit.name} skipped, since ${blocker.task.name} did not pass\n`);
					} else if (
						!stopping &&
						before.every((each) => outcomes.get(each) === "passed") &&
						(previous === undefined || outcomes.has(previous))
					) {
						const hit = hits.get(unit);
						if (hit === undefined) start(unit);
						else replay(unit, hit);
					}
				}
				if (running.size === 0) done();
			};
			/** Record how `unit` ended, which `schedule` then acts on. */
			const finish = (unit: Unit, outcome: Outcome, line: string) => {
				outcomes.set(unit, outcome);
				io.stderr(`quest: ${unit.name} ${outcome}${line}\n`);
				if (outcome === "failed" && options.failFast && !stopping) {
					stopping = true;
					signalAll("SIGTERM");
				}
			};
			/**
			 * Pass `unit` on a recorded pass of the same inputs, writing the reports it recorded where the task declares
			 * them, so no earlier run's report stands in for them, and under --report.
			 */
			const replay = (unit: Unit, hit: TaskResult) => {
				const destination = reportDir(report, unit);
				try {
					for (const { path, name } of declared(unit.task)) {
						const file = join(top, path);
						rmSync(file, { force: true });
						const recorded = hit.reports.find((each) => each.name === name);
						if (recorded === undefined) continue;
						mkdirSync(dirname(file), { recursive: true });
						writeFileSync(file, Buffer.from(recorded.base64, "base64"));
					}
					if (destination !== null) {
						mkdirSync(destination, { recursive: true });
						for (const { name, base64 } of hit.reports)
							writeFileSync(join(destination, name), Buffer.from(base64, "base64"));
					}
				} catch (error) {
					finish(unit, "failed", `: cannot copy its cached reports: ${(error as Error).message}`);
					return;
				}
				outcomes.set(unit, "passed");
				results.set(unit, "hit");
				io.stderr(`quest: ${unit.name} passed, cached (hit)\n`);
			};
			const start = (unit: Unit) => {
				const { task } = unit;
				const outputs = declared(task);
				try {
					for (const { path } of outputs) rmSync(join(top, path), { force: true });
				} catch (error) {
					finish(unit, "failed", `: cannot remove an earlier report: ${(error as Error).message}`);
					return;
				}
				const started = io.now();
				const argv = programCommand(programs.quest, ["gate", ...command(task)], io.env);
				io.stderr(`quest: ${unit.name} started\n`);
				const child = spawn(argv.file, argv.args, {
					cwd: top,
					env: unit.crate === null ? env : { ...env, QUEST_CRATE: unit.crate.name },
					stdio: ["ignore", "pipe", "pipe"],
					detached,
					windowsVerbatimArguments: argv.windowsVerbatimArguments,
				});
				running.set(unit, child);
				const prefix = `${unit.name.padEnd(width)} | `;
				const lines = [prefixed(prefix, child.stdout!, io.stdout), prefixed(prefix, child.stderr!, io.stderr)];
				let failure: string | null = null;
				child.on("error", (error) => {
					failure = error.message;
				});
				child.on("close", (code, signal) => {
					for (const flush of lines) flush();
					running.delete(unit);
					const seconds = (io.now() - started) / 1000;
					results.set(unit, `${seconds.toFixed(1)}s`);
					const status = failure ?? (code === 0 ? null : `exit ${code ?? signal}`);
					let problems: string[];
					let reports: TaskResult["reports"] = [];
					try {
						problems = collect(top, outputs, status === null, reportDir(report, unit));
						if (status === null && problems.length === 0)
							reports = outputs.map(({ path, name }) => ({
								name,
								base64: readFileSync(join(top, path)).toString("base64"),
							}));
					} catch (error) {
						problems = [`cannot collect its reports: ${(error as Error).message}`];
					}
					if (status === null && problems.length === 0) {
						finish(unit, "passed", ` in ${seconds.toFixed(1)}s`);
						// A pass counts for the inputs the digest named only while nothing changed them as the task ran,
						// such as an edit saved meanwhile.
						const record = cache !== null && task.cache && unit.digest !== null;
						// Caught here, since a throw from this handler would end the run while other tasks still run.
						let changed: string | null = null;
						if (record)
							try {
								const key = digestOf!(unit, treeFiles(top));
								if (!("digest" in key) || key.digest !== unit.digest)
									changed = "its inputs changed while it ran";
							} catch (error) {
								changed = `its inputs could not be read again: ${(error as Error).message}`;
							}
						if (changed !== null) io.stderr(`quest: ${unit.name} is not cached, since ${changed}\n`);
						else if (record)
							// Caught at once, so a failed write fails the run once its tasks finish, not the process.
							writes.push(
								cache!
									.set(unit.digest!, {
										task: task.name,
										crate: unit.crate?.name ?? null,
										seconds,
										reports,
									})
									.catch((error: unknown) => {
										writeFailure ??= error;
									}),
							);
					} else {
						const why = [...(status === null ? [] : [status]), ...problems].join("; ");
						finish(
							unit,
							stopping && status !== null ? "cancelled" : "failed",
							` in ${seconds.toFixed(1)}s: ${why}`,
						);
					}
					schedule();
				});
			};
			schedule();
		});
	} finally {
		unfollow();
		cancel.close();
	}

	await Promise.all(writes);
	if (writeFailure !== undefined)
		throw new Error(
			`cannot record a pass in the task cache: ${writeFailure instanceof Error ? writeFailure.message : String(writeFailure)}`,
		);

	const counts = new Map<Outcome, number>();
	for (const unit of units) {
		const outcome = outcomes.get(unit) ?? "skipped";
		counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
		const result = results.get(unit);
		if (result === "hit") io.stderr(`quest: cached (hit) ${unit.name}\n`);
		else if (result !== undefined)
			io.stderr(`quest: ran ${unit.name} (${result}${outcome === "passed" ? "" : `, ${outcome}`})\n`);
	}
	const cached = [...results.values()].filter((result) => result === "hit").length;
	io.stderr(
		`quest: ${OUTCOMES.flatMap((each) =>
			counts.has(each)
				? [`${counts.get(each)} ${each}${each === "passed" && cached > 0 ? ` (${cached} cached)` : ""}`]
				: [],
		).join(", ")}\n`,
	);
	if (cancel.signal.aborted) return cancelled(cancel.signal);
	return counts.has("failed") || counts.has("cancelled") ? 1 : 0;
}

const OUTCOMES = ["passed", "failed", "cancelled", "skipped"] as const;
type Outcome = (typeof OUTCOMES)[number];

/** One run of a task: the task itself, or one crate of a Cargo task. */
interface Unit {
	task: ManifestTask;
	crate: CargoCrate | null;
	/** The task's name, then `:` and the crate's for one crate. */
	name: string;
	/** The digest of everything it reads, when the run uses the cache. */
	digest: string | null;
}

/** Where `--report` copies `unit`'s reports: `<dir>/<task>`, then `/<crate>` for one crate's. */
function reportDir(report: string | null, unit: Unit): string | null {
	if (report === null) return null;
	return unit.crate === null ? join(report, unit.task.name) : join(report, unit.task.name, unit.crate.name);
}

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
	outputs: { path: string; name: string }[],
	passed: boolean,
	destination: string | null,
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
		if (destination !== null) {
			mkdirSync(destination, { recursive: true });
			copyFileSync(file, join(destination, name));
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
