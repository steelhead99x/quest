// A repository's CI and release lifecycle, declared in its root `quest.toml`: the tasks `quest run` picks for a tier
// and a change, the order they run in, and where. Pure like the rest of the core, so Kixel Quest's Worker validates a
// manifest straight from a git tree.
import { parse, TomlError } from "smol-toml";

import { HOST, type Host } from "./doc";
import { matches, patternError } from "./risk";

/** The manifest's path from the repository root. */
export const MANIFEST_FILE = "quest.toml";

/**
 * The tiers a task runs in: each PR push, the merge gate, nightly, the gate before a release, and the release itself.
 * A run of one of the first four also runs every tier before it; a `release` run runs only its own tasks, which publish.
 */
export const TASK_TIERS = ["pr", "gate", "nightly", "release-gate", "release"] as const;
export type TaskTier = (typeof TASK_TIERS)[number];

/** Whether a run of tier `run` includes a task of tier `task`. */
function includes(run: TaskTier, task: TaskTier): boolean {
	if (run === "release") return task === "release";
	return task !== "release" && TASK_TIERS.indexOf(task) <= TASK_TIERS.indexOf(run);
}

/** A parsed `quest.toml`. */
export interface Manifest {
	repo: ManifestRepo;
	/** The tasks in the order the manifest declares them. */
	tasks: ManifestTask[];
}

/** The manifest's `[repo]` table. */
export interface ManifestRepo {
	/** The branch PRs merge into, whose `origin` tip a run diffs against by default; `main` unless set. */
	merge: string;
	/** The branch release PRs merge into, or null for a repository without one. */
	release: string | null;
	/** The flake outputs `quest cache push` publishes. */
	cache: string[];
	/** Path patterns whose change selects every task; a change to the manifest itself always does. */
	invalidateAll: string[];
}

/** One `[tasks.<name>]` table. */
export interface ManifestTask {
	name: string;
	tier: TaskTier;
	/** The Bash script the task runs from the repository root. */
	run: string;
	/** The tasks that must pass first, which a run of this one also runs. */
	after: string[];
	/** Path patterns a change must touch to select the task, or null for any change. */
	paths: string[] | null;
	/** Path patterns whose change never selects the task. */
	exclude: string[];
	/** Path patterns the task also reads outside `paths`, which select it too. */
	inputs: string[];
	/** The shared build caches the task uses, such as `mbx`, for a runner to provision. */
	caches: string[];
	/** The operating systems the task runs on. */
	os: Host[];
	/** What a runner's host needs beyond the OS, such as `kvm`, for a dispatcher to route on. */
	capabilities: string[];
	/** Whether the task runs in the repository's Nix dev shell. */
	nix: boolean;
	/** Whether the task runs once per crate of the root Cargo workspace, with `QUEST_CRATE` naming it. */
	cargo: boolean;
	/**
	 * Whether a passing result may be reused for the same inputs: by default a Nix task's that no task runs after,
	 * since a reused result restores no files another task could read, that declares no metrics and is outside the
	 * nightly and release tiers, and never a task without Nix, whose host toolchain nothing pins.
	 */
	cache: boolean;
	/** Variables set for the task. */
	environment: Record<string, string>;
	/**
	 * Variables the task reads from the caller's environment, whose values its cache digest covers, as `inputs`
	 * names the files it reads outside `paths`: a pass for one value is never reused for another.
	 */
	inherit: string[];
	/** The JUnit XML report the task writes, from the repository root, or null. */
	junit: string | null;
	/** The `metrics.json` the task writes, from the repository root, or null. */
	metrics: string | null;
}

/** A manifest, or every reason it cannot be read. */
export type ParsedManifest = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

/** The variables `quest run` sets for every task, which a task's `environment` cannot replace. */
const RESERVED = ["QUEST_BASE", "QUEST_CRATE", "QUEST_TIER"];

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_KEYS = ["merge", "release", "cache", "invalidate_all"];
const TASK_KEYS = [
	"tier",
	"run",
	"after",
	"paths",
	"exclude",
	"inputs",
	"caches",
	"os",
	"capabilities",
	"nix",
	"cargo",
	"cache",
	"environment",
	"inherit",
	"junit",
	"metrics",
];

type Table = Record<string, unknown>;

/** A TOML table, which smol-toml builds without a prototype, unlike its dates. */
const isTable = (value: unknown): value is Table =>
	typeof value === "object" && value !== null && Object.getPrototypeOf(value) === null;

/** Reads typed values out of the parsed TOML, noting each problem under the table it came from. */
class Reader {
	readonly problems: string[] = [];

	problem(where: string, message: string): void {
		this.problems.push(`${MANIFEST_FILE}: ${where}: ${message}`);
	}

	/** Note each key of `table` outside `known`. */
	keys(where: string, table: Table, known: readonly string[]): void {
		for (const key of Object.keys(table)) if (!known.includes(key)) this.problem(where, `unknown key \`${key}\``);
	}

	string(where: string, value: unknown): string | undefined {
		if (typeof value === "string" && value.trim() !== "") return value;
		this.problem(where, "expected a non-empty string");
		return undefined;
	}

	boolean(where: string, value: unknown): boolean | undefined {
		if (typeof value === "boolean") return value;
		this.problem(where, "expected true or false");
		return undefined;
	}

	/** A list of distinct strings, each of which `check` accepts or explains. */
	list(where: string, value: unknown, check: (item: string) => string | null): string[] {
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			this.problem(where, "expected a list of strings");
			return [];
		}
		const items = value as string[];
		for (const item of items) {
			const error = check(item);
			if (error !== null) this.problem(where, `\`${item}\`: ${error}`);
		}
		const repeated = items.filter((item, index) => items.indexOf(item) !== index);
		for (const item of new Set(repeated)) this.problem(where, `\`${item}\` is listed twice`);
		return items;
	}

	patterns(where: string, value: unknown): string[] {
		return this.list(where, value, patternError);
	}

	labels(where: string, value: unknown): string[] {
		return this.list(where, value, (item) =>
			LABEL.test(item) ? null : "expected letters, digits, `_`, `.`, or `-`",
		);
	}

	/** A file path from the repository root. */
	file(where: string, value: unknown): string | null {
		const path = this.string(where, value);
		if (path === undefined) return null;
		const error =
			/[*?]/.test(path) || path.endsWith("/") ? "expected a file path, not a pattern" : patternError(path);
		if (error !== null) this.problem(where, error);
		return path;
	}
}

/**
 * Parse and validate a `quest.toml`: its TOML, every key and value, and that each task's `after` names a declared
 * task, of the same tier or an earlier one, that runs on every OS this one does, without a cycle.
 */
export function parseQuestManifest(text: string): ParsedManifest {
	let root: Table;
	try {
		root = parse(text) as Table;
	} catch (error) {
		if (!(error instanceof TomlError)) throw error;
		const message = error.message.split("\n")[0]!.replace(/^Invalid TOML document: /, "");
		return { ok: false, problems: [`${MANIFEST_FILE}:${error.line}:${error.column}: ${message}`] };
	}
	const read = new Reader();
	read.keys("top level", root, ["repo", "tasks"]);
	const repo = readRepo(read, root.repo ?? Object.create(null));
	const tables = root.tasks ?? Object.create(null);
	const tasks: ManifestTask[] = [];
	/** The tasks whose `cache` is the default, which depends on whether another task runs after them. */
	const settle: ManifestTask[] = [];
	if (!isTable(tables)) read.problem("tasks", "expected a table of `[tasks.<name>]` tables");
	else {
		for (const [name, table] of Object.entries(tables)) {
			const task = readTask(read, name, table);
			if (task === null) continue;
			tasks.push(task);
			if (task.cache && !task.nix)
				read.problem(
					`[tasks.${name}] cache`,
					"nothing pins the toolchain of a task without Nix, so its result cannot be reused",
				);
			// A result reused for a task others run after would leave them without the files it writes.
			else if ((table as Table).cache === undefined) settle.push(task);
		}
		for (const task of settle) task.cache &&= !tasks.some((other) => other.after.includes(task.name));
		checkAfter(read, tasks);
		checkReports(read, tasks);
	}
	return read.problems.length > 0 ? { ok: false, problems: read.problems } : { ok: true, manifest: { repo, tasks } };
}

function readRepo(read: Reader, table: unknown): ManifestRepo {
	const repo: ManifestRepo = { merge: "main", release: null, cache: [], invalidateAll: [] };
	if (!isTable(table)) {
		read.problem("repo", "expected a table");
		return repo;
	}
	read.keys("[repo]", table, REPO_KEYS);
	if (table.merge !== undefined) repo.merge = read.string("[repo] merge", table.merge) ?? repo.merge;
	if (table.release !== undefined) repo.release = read.string("[repo] release", table.release) ?? null;
	if (table.cache !== undefined) repo.cache = read.labels("[repo] cache", table.cache);
	if (table.invalidate_all !== undefined)
		repo.invalidateAll = read.patterns("[repo] invalidate_all", table.invalidate_all);
	return repo;
}

function readTask(read: Reader, name: string, table: unknown): ManifestTask | null {
	const where = `[tasks.${name}]`;
	if (!NAME.test(name)) read.problem(where, "a task name holds only letters, digits, `_`, and `-`");
	if (!isTable(table)) {
		read.problem(where, "expected a table");
		return null;
	}
	read.keys(where, table, TASK_KEYS);
	const field = (key: string) => `${where} ${key}`;

	let tier: TaskTier | undefined;
	if (table.tier === undefined) read.problem(where, "missing `tier`");
	else if (TASK_TIERS.includes(table.tier as TaskTier)) tier = table.tier as TaskTier;
	else read.problem(field("tier"), `expected one of ${TASK_TIERS.join(", ")}`);
	let run: string | undefined;
	if (table.run === undefined) read.problem(where, "missing `run`");
	else run = read.string(field("run"), table.run);

	const nix = table.nix === undefined ? true : (read.boolean(field("nix"), table.nix) ?? true);
	let os: Host[] = nix ? HOST.filter((host) => host !== "windows") : [...HOST];
	if (table.os !== undefined) {
		os = read.list(field("os"), table.os, (item) =>
			HOST.includes(item as Host) ? null : `expected one of ${HOST.join(", ")}`,
		) as Host[];
		if (Array.isArray(table.os) && table.os.length === 0) read.problem(field("os"), "names no operating system");
		if (nix && os.includes("windows"))
			read.problem(field("os"), "Nix does not run on windows; set `nix = false` for a task that runs there");
	}

	const environment: Record<string, string> = {};
	if (table.environment !== undefined) {
		if (!isTable(table.environment)) read.problem(field("environment"), "expected a table of strings");
		else
			for (const [key, value] of Object.entries(table.environment)) {
				if (!VARIABLE.test(key)) read.problem(field("environment"), `\`${key}\` is not a variable name`);
				else if (RESERVED.includes(key)) read.problem(field("environment"), `quest run sets \`${key}\` itself`);
				if (typeof value !== "string") read.problem(field("environment"), `\`${key}\` is not a string`);
				else environment[key] = value;
			}
	}

	const list = (key: string, parse: (where: string, value: unknown) => string[]) =>
		table[key] === undefined ? [] : parse(field(key), table[key]);
	const task: ManifestTask = {
		name,
		tier: tier ?? "pr",
		run: run ?? "",
		after: list("after", (where, value) => read.list(where, value, () => null)),
		paths: table.paths === undefined ? null : read.patterns(field("paths"), table.paths),
		exclude: list("exclude", (where, value) => read.patterns(where, value)),
		inputs: list("inputs", (where, value) => read.patterns(where, value)),
		caches: list("caches", (where, value) => read.labels(where, value)),
		os: HOST.filter((host) => os.includes(host)),
		capabilities: list("capabilities", (where, value) => read.labels(where, value)),
		nix,
		cargo: table.cargo === undefined ? false : (read.boolean(field("cargo"), table.cargo) ?? false),
		// The default is settled once every task's `after` is known.
		// A nightly task, such as a benchmark or a live interop suite, must run again on the same code, a release
		// task publishes, and metrics describe the run that wrote them: a reused pass would skip each.
		cache:
			table.cache === undefined
				? nix && tier !== "nightly" && tier !== "release" && table.metrics === undefined
				: (read.boolean(field("cache"), table.cache) ?? false),
		environment,
		inherit: list("inherit", (where, value) =>
			read.list(where, value, (item) =>
				!VARIABLE.test(item)
					? "not a variable name"
					: RESERVED.includes(item)
						? "quest run sets it itself"
						: item in environment
							? "set by `environment`, so not inherited"
							: null,
			),
		),
		junit: table.junit === undefined ? null : read.file(field("junit"), table.junit),
		metrics: table.metrics === undefined ? null : read.file(field("metrics"), table.metrics),
	};
	return task;
}

/**
 * Note each report path two tasks declare that may run at once, which would collect each other's file: neither runs
 * after the other. Paths compare without case, as macOS and Windows checkouts name files.
 */
function checkReports(read: Reader, tasks: ManifestTask[]): void {
	const byName = new Map(tasks.map((task) => [task.name, task]));
	/** Every task `task` runs after, directly or not. */
	const before = (task: ManifestTask, seen = new Set<string>()): Set<string> => {
		for (const name of task.after) {
			const first = byName.get(name);
			if (first === undefined || seen.has(name)) continue;
			seen.add(name);
			before(first, seen);
		}
		return seen;
	};
	const owners = new Map<string, { task: ManifestTask; path: string }[]>();
	for (const task of tasks)
		for (const [key, path] of [
			["junit", task.junit],
			["metrics", task.metrics],
		] as const) {
			if (path === null) continue;
			const others = owners.get(path.toLowerCase()) ?? [];
			const clash = others.find(
				(other) =>
					other.task === task || (!before(task).has(other.task.name) && !before(other.task).has(task.name)),
			);
			if (clash?.task === task) read.problem(`[tasks.${task.name}] ${key}`, "is also the task's junit report");
			else if (clash !== undefined)
				read.problem(
					`[tasks.${task.name}] ${key}`,
					`\`${clash.task.name}\` may run at the same time and also writes \`${clash.path}\``,
				);
			owners.set(path.toLowerCase(), [...others, { task, path }]);
		}
}

/** Note each `after` entry naming no task, a later tier, or fewer operating systems, and each cycle. */
function checkAfter(read: Reader, tasks: ManifestTask[]): void {
	const byName = new Map(tasks.map((task) => [task.name, task]));
	for (const task of tasks) {
		const where = `[tasks.${task.name}] after`;
		for (const name of task.after) {
			const first = byName.get(name);
			if (first === undefined) {
				read.problem(where, `no task is named \`${name}\``);
				continue;
			}
			if (TASK_TIERS.indexOf(first.tier) > TASK_TIERS.indexOf(task.tier))
				read.problem(
					where,
					`\`${name}\` is in the later tier ${first.tier}, so a ${task.tier} run would pull it in`,
				);
			const missing = task.os.filter((host) => !first.os.includes(host));
			if (missing.length > 0) read.problem(where, `\`${name}\` does not run on ${missing.join(", ")}`);
		}
	}
	// Depth-first, reporting each cycle once from the first task on it.
	const state = new Map<string, "open" | "done">();
	const visit = (task: ManifestTask, path: string[]) => {
		state.set(task.name, "open");
		for (const name of task.after) {
			const next = byName.get(name);
			if (next === undefined) continue;
			if (state.get(name) === "open") {
				const cycle = [...path.slice(path.indexOf(name)), name];
				read.problem(`[tasks.${cycle[0]}] after`, `cycle ${cycle.map((each) => `\`${each}\``).join(" -> ")}`);
			} else if (!state.has(name)) visit(next, [...path, name]);
		}
		state.set(task.name, "done");
	};
	for (const task of tasks) if (!state.has(task.name)) visit(task, [task.name]);
}

/** What a run picks from a manifest. */
export interface TaskPick {
	tier: TaskTier;
	/** The tasks to run whatever their tier or the change, or null to pick by tier. */
	only: readonly string[] | null;
	/** The paths the change touched, both sides of a rename included, or null to pick every task of the tier. */
	changed: readonly string[] | null;
	/** The operating systems to run on; a task runs where it lists one of them. */
	os: readonly Host[];
}

/** Whether `task` reads a path in `changed`. */
function touched(task: ManifestTask, changed: readonly string[]): boolean {
	const scope = task.paths === null ? null : [...task.paths, ...task.inputs];
	return changed.some(
		(path) =>
			(scope === null || scope.some((pattern) => matches(pattern, path))) &&
			!task.exclude.some((pattern) => matches(pattern, path)),
	);
}

/**
 * The tasks a run picks, and every task they run after, each after those it runs after and otherwise in the
 * manifest's order. A change to the manifest, or to a path `invalidate_all` matches, picks every task of the tier.
 * Throws when `only` names a task the manifest lacks or that runs on none of `os`.
 */
export function pickTasks(manifest: Manifest, pick: TaskPick): ManifestTask[] {
	const byName = new Map(manifest.tasks.map((task) => [task.name, task]));
	const runsHere = (task: ManifestTask) => task.os.some((host) => pick.os.includes(host));
	let chosen: ManifestTask[];
	if (pick.only !== null) {
		chosen = pick.only.map((name) => {
			const task = byName.get(name);
			if (task === undefined) throw new Error(`${MANIFEST_FILE} declares no task named ${name}`);
			if (!runsHere(task)) throw new Error(`task ${name} runs only on ${task.os.join(", ")}`);
			return task;
		});
	} else {
		const changed = pick.changed;
		const everything =
			changed === null ||
			changed.some(
				(path) =>
					path === MANIFEST_FILE || manifest.repo.invalidateAll.some((pattern) => matches(pattern, path)),
			);
		chosen = manifest.tasks.filter(
			(task) => includes(pick.tier, task.tier) && runsHere(task) && (everything || touched(task, changed)),
		);
	}
	// Close over `after`, then order: the manifest validated every name and ruled out cycles.
	const wanted = new Set<string>();
	const add = (task: ManifestTask) => {
		if (wanted.has(task.name)) return;
		wanted.add(task.name);
		for (const name of task.after) add(byName.get(name)!);
	};
	for (const task of chosen) add(task);
	const ordered: ManifestTask[] = [];
	const placed = new Set<string>();
	const place = (task: ManifestTask) => {
		if (placed.has(task.name)) return;
		placed.add(task.name);
		for (const name of task.after) place(byName.get(name)!);
		ordered.push(task);
	};
	for (const task of manifest.tasks) if (wanted.has(task.name)) place(task);
	return ordered;
}
