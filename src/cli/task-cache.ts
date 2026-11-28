// `quest run`'s task result cache: a digest of everything a task reads, and the passes recorded under it on this host,
// so a task whose inputs a pass already covered is not run again.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { parse } from "smol-toml";

import { type ManifestTask, matches } from "../core";
import { type DiskCache, diskCache } from "./disk-cache";
import { git } from "./git";

/** A file of the working tree as Git would store it. */
export interface TreeFile {
	path: string;
	/** Git's mode: `100644`, `100755`, `120000` for a symlink, or `160000` for a submodule. */
	mode: string;
	/** The blob or commit id Git gives its content, or {@link DIRTY} for a submodule with uncommitted changes. */
	oid: string;
}

/** The id of a submodule whose working tree holds changes no commit does, which no digest can name. */
export const DIRTY = "dirty";

/**
 * Every file of the working tree at `top` that Git tracks or would add, sorted by path, with the ids Git gives
 * them: the index's where the file matches it byte for byte, so a clean checkout reads no file, and hashed from the
 * working tree's own bytes, without Git's filters, where it is modified, untracked, or one whose bytes checkout may
 * convert. Ignored and deleted files and untracked nested repositories are left out.
 */
export function treeFiles(top: string): TreeFile[] {
	const list = (args: string[]) => git(top, args).split("\0").filter(Boolean);
	const files = new Map<string, TreeFile>();
	const dirty = new Set<string>();
	for (const line of list(["ls-files", "--stage", "-z"])) {
		const tab = line.indexOf("\t");
		const [mode, oid, stage] = line.slice(0, tab).split(" ");
		const path = line.slice(tab + 1);
		// A conflicted path holds its sides in stages 1 to 3; its working-tree file is what a task reads.
		if (stage === "0") files.set(path, { path, mode: mode!, oid: oid! });
		else dirty.add(path);
	}
	const indexed = new Map(files);
	for (const path of convertedCheckouts(
		top,
		[...files.values()].filter((file) => file.mode.startsWith("100")).map((file) => file.path),
	))
		dirty.add(path);
	// A submodule with edits inside it is listed too, rather than passing as its gitlink.
	for (const path of list(["diff-files", "--name-only", "--ignore-submodules=none", "-z"])) dirty.add(path);
	for (const path of list(["ls-files", "--others", "--exclude-standard", "-z"])) dirty.add(path);

	const regular: TreeFile[] = [];
	for (const path of dirty) {
		files.delete(path);
		const info = lstatSync(join(top, path), { throwIfNoEntry: false });
		if (info === undefined) continue;
		if (info.isSymbolicLink())
			files.set(path, {
				path,
				mode: "120000",
				oid: git(top, ["hash-object", "--stdin"], readlinkSync(join(top, path), "utf8")),
			});
		else if (info.isDirectory()) {
			// An untracked nested repository, such as an agent's worktree, is no part of the tree.
			if (indexed.get(path)?.mode === "160000") files.set(path, { path, mode: "160000", oid: DIRTY });
		} else {
			if (path.includes("\n")) throw new Error(`cannot hash ${JSON.stringify(path)}, whose name holds a newline`);
			// Git records only the owner's execute bit.
			const file = { path, mode: info.mode & 0o100 ? "100755" : "100644", oid: "" };
			regular.push(file);
			files.set(path, file);
		}
	}
	if (regular.length > 0) {
		// Unfiltered, so a file whose bytes differ from its commit's, such as with CRLF endings, never matches it.
		const paths = regular.map((file) => file.path).join("\n");
		const oids = git(top, ["hash-object", "--no-filters", "--stdin-paths"], paths).split("\n");
		regular.forEach((file, index) => (file.oid = oids[index]!));
	}
	return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The paths among `paths` whose bytes checkout may convert, by their attributes and this checkout's configuration:
 * through a `filter` driver, such as Git LFS, whose smudge a checkout may skip, a `working-tree-encoding`, or to
 * CRLF line endings by `core.autocrlf` and `core.eol`, as Git's `convert.c` decides. Such a file reads as clean
 * while its bytes differ from its blob's, and maybe from another checkout's of the same commit. Asking costs no file
 * reads, unlike `ls-files --eol`.
 */
function convertedCheckouts(top: string, paths: string[]): string[] {
	if (paths.length === 0) return [];
	const autocrlf = git(top, ["config", "--get", "core.autocrlf"]).toLowerCase();
	const eol = git(top, ["config", "--get", "core.eol"]).toLowerCase();
	// The ending a `text` file without an `eol` attribute gets.
	const autoTrue = ["true", "yes", "on", "1"].includes(autocrlf);
	const textCrlf =
		autoTrue || (autocrlf !== "input" && (eol === "crlf" || (eol !== "lf" && process.platform === "win32")));
	const out = git(
		top,
		["check-attr", "-z", "--stdin", "text", "eol", "crlf", "filter", "working-tree-encoding"],
		paths.join("\0"),
	).split("\0");
	const attrs = new Map<string, Record<string, string>>();
	for (let index = 0; index + 2 < out.length; index += 3) {
		const [path, name, value] = [out[index]!, out[index + 1]!, out[index + 2]!];
		if (!attrs.has(path)) attrs.set(path, {});
		attrs.get(path)![name] = value;
	}
	return paths.filter((path) => {
		const { text, eol: attr, crlf, filter, "working-tree-encoding": encoding } = attrs.get(path) ?? {};
		const set = (value: string | undefined) => value !== undefined && value !== "unspecified" && value !== "unset";
		if (set(filter) || set(encoding)) return true;
		// The legacy `crlf` attribute stands in for an unspecified `text`.
		const kind = text === "set" || text === "auto" || text === "unset" ? text : crlf === "input" ? "input" : crlf;
		if (kind === "unset" || kind === "input") return false;
		if (attr === "crlf") return true;
		if (attr === "lf") return false;
		return kind === "set" || kind === "auto" ? textCrlf : autoTrue;
	});
}

/** The Nix system this host builds for, as a flake's outputs name it. */
export function nixSystem(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
	const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
	if (cpu === null || os === null)
		throw new Error(`the task cache supports Nix on x64 and arm64 Linux and macOS, not ${arch} ${platform}`);
	return `${cpu}-${os}`;
}

/** The shell `nix develop` enters for a flake. */
export interface DevShell {
	/** The store path of its derivation, which pins every tool a Nix task runs with. */
	derivation: string;
	/** What `quest.lib.mkFlake`'s shell of this toolchain exports as `QUEST_DEV_SHELL_ID`; null for any other shell. */
	identity: string | null;
}

/**
 * The shell `nix develop` enters for the flake at `top`, trying the outputs it tries in its order. Evaluating it costs
 * a few seconds, which a run pays once.
 */
export function devShell(nix: string, top: string, env: NodeJS.ProcessEnv): DevShell {
	const system = nixSystem();
	const outputs = [
		`devShells.${system}.default`,
		`devShell.${system}`,
		`packages.${system}.default`,
		`defaultPackage.${system}`,
	];
	for (const output of outputs) {
		const apply = "d: { drv = d.drvPath; id = d.questShell or null; }";
		const result = spawnSync(nix, ["eval", "--json", `${top}#${output}`, "--apply", apply], {
			cwd: top,
			env,
			encoding: "utf8",
			maxBuffer: 1 << 24,
		});
		if (result.error) throw result.error;
		if (result.status === 0) {
			const { drv, id } = JSON.parse(result.stdout) as { drv: unknown; id: unknown };
			if (typeof drv === "string" && /^\/\S+\.drv$/.test(drv) && (id === null || typeof id === "string"))
				return { derivation: drv, identity: id };
		}
		if (result.status !== 0 && /does not provide attribute/.test(result.stderr)) continue;
		throw new Error(
			`cannot evaluate ${output} to fingerprint the dev shell for the task cache; pass --no-cache to run without it:\n${result.stderr.trim()}`,
		);
	}
	throw new Error(`the flake provides none of ${outputs.join(", ")} for nix develop to enter`);
}

/** One crate of a Cargo workspace and everything its tests build from. */
export interface CargoCrate {
	name: string;
	/** The directories, from the workspace root, of the crate and each workspace crate it depends on. */
	dirs: string[];
	/** Each registry or git package it depends on, by name, version, source, and enabled features. */
	packages: string[];
	/** The name of every package in its closure, itself included. */
	names: string[];
	/**
	 * The directory of each path crate its closure declares that `cargo metadata` lists nowhere, such as an optional
	 * one only a task's `--features` enables on a crate outside the workspace, whose files no digest could name.
	 */
	unlisted: string[];
}

/** A workspace's crates, and the directory of every crate with a path source, members or not. */
export interface CargoWorkspace {
	crates: CargoCrate[];
	dirs: string[];
}

interface Metadata {
	workspace_root: string;
	workspace_members: string[];
	packages: {
		id: string;
		name: string;
		version: string;
		source: string | null;
		manifest_path: string;
		dependencies?: { kind: string | null; path?: string }[];
	}[];
	resolve: {
		nodes: { id: string; features: string[]; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
	};
}

/**
 * The crates of the workspace at `top`, from `cargo metadata --locked --format-version 1`'s output: each member,
 * the crates it depends on through every kind of dependency, and what those depend on to build, without their
 * dev-dependencies. A path crate outside the repository is an error, since nothing would hash its source.
 */
export function cargoWorkspace(output: string, top: string): CargoWorkspace {
	const metadata = JSON.parse(output) as Metadata;
	if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes))
		throw new Error("cargo metadata printed no packages and resolve graph");
	if (relative(top, metadata.workspace_root) !== "")
		throw new Error(
			`cargo = true needs the Cargo workspace at the repository root, not ${metadata.workspace_root}`,
		);
	const packages = new Map(metadata.packages.map((each) => [each.id, each]));
	const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
	const dir = (id: string): string | null => {
		const found = packages.get(id)!;
		if (found.source !== null) return null;
		const path = relative(metadata.workspace_root, dirname(found.manifest_path));
		if (path.startsWith("..") || isAbsolute(path))
			throw new Error(
				`crate ${found.name} is a path dependency outside the repository, at ${found.manifest_path}`,
			);
		return path.split(sep).join("/");
	};
	// A path crate by its directory, so a declared path dependency the resolve graph has no edge to, such as an
	// optional one a task's feature flags enable on a crate outside the workspace while another crate needs it anyway,
	// still joins the closure.
	const byDir = new Map(
		metadata.packages.flatMap((each) => (each.source === null ? [[dirname(each.manifest_path), each.id]] : [])),
	);
	const crates = metadata.workspace_members.map((member) => {
		const seen = new Set<string>();
		const unlisted = new Set<string>();
		const visit = (id: string, root: boolean) => {
			if (seen.has(id)) return;
			seen.add(id);
			for (const dep of nodes.get(id)?.deps ?? [])
				if (root || dep.dep_kinds.some((kind) => kind.kind !== "dev")) visit(dep.pkg, false);
			for (const dep of packages.get(id)!.dependencies ?? []) {
				// A crate outside the workspace builds without its dev-dependencies, which Cargo then leaves out.
				if (dep.path === undefined || (!root && dep.kind === "dev")) continue;
				const path = byDir.get(dep.path);
				if (path !== undefined) visit(path, false);
				else unlisted.add(relative(metadata.workspace_root, dep.path).split(sep).join("/"));
			}
		};
		visit(member, true);
		const dirs: string[] = [];
		const external: string[] = [];
		for (const id of seen) {
			const path = dir(id);
			if (path !== null) dirs.push(path);
			else {
				const { name, version, source } = packages.get(id)!;
				const features = [...(nodes.get(id)?.features ?? [])].sort().join(",");
				external.push(`${name} ${version} ${source} [${features}]`);
			}
		}
		const names = [...new Set([...seen].map((id) => packages.get(id)!.name))].sort();
		return {
			name: packages.get(member)!.name,
			dirs: dirs.sort(),
			packages: external.sort(),
			names,
			unlisted: [...unlisted].sort(),
		};
	});
	const dirs = metadata.packages.flatMap((each) => {
		const path = dir(each.id);
		return path === null ? [] : [path];
	});
	return { crates: crates.sort((a, b) => (a.name < b.name ? -1 : 1)), dirs };
}

/** Files at a Cargo workspace's root that every crate builds or tests with. */
const CARGO_SHARED = [
	".cargo/config.toml",
	".cargo/config",
	"rust-toolchain.toml",
	"rust-toolchain",
	".config/nextest.toml",
];

/**
 * The root `Cargo.toml` as a crate reads it: `[workspace.dependencies]` keeps only the entries for packages in its
 * closure, which `names` lists, so bumping or retuning one crate's dependency leaves the others' digests alone.
 */
export function workspaceManifest(text: string, names: readonly string[]): string {
	const manifest = parse(text) as Record<string, unknown>;
	const workspace = manifest.workspace as Record<string, unknown> | undefined;
	const dependencies = workspace?.dependencies as Record<string, unknown> | undefined;
	if (dependencies !== undefined)
		for (const [key, entry] of Object.entries(dependencies)) {
			// An entry may rename its package.
			const renamed = (entry as { package?: unknown } | null)?.package;
			if (!names.includes(typeof renamed === "string" ? renamed : key)) delete dependencies[key];
		}
	return JSON.stringify(manifest);
}

/** The files `task` reads, where `crate` names the crate of a Cargo task's run, from the files `files` lists. */
export function inputFiles(
	task: ManifestTask,
	files: TreeFile[],
	invalidateAll: string[],
	cargo: { crate: CargoCrate; workspace: CargoWorkspace } | null,
): TreeFile[] {
	const owner = (path: string): string | undefined => {
		let found: string | undefined;
		for (const dir of cargo!.workspace.dirs)
			if ((dir === "" || path.startsWith(`${dir}/`)) && (found === undefined || dir.length > found.length))
				found = dir;
		return found;
	};
	const reads = ({ path, mode }: TreeFile): boolean => {
		if (task.inputs.some((pattern) => matches(pattern, path))) return true;
		if (cargo === null) return task.paths === null || task.paths.some((pattern) => matches(pattern, path));
		if (CARGO_SHARED.includes(path)) return true;
		// A submodule holding one of the crate's directories, whose files Git lists only as its commit.
		if (mode === "160000" && cargo.crate.dirs.some((dir) => dir === path || dir.startsWith(`${path}/`)))
			return true;
		const dir = owner(path);
		if (dir !== undefined && cargo.crate.dirs.includes(dir)) return true;
		// Outside the member crates, even where a root package owns it: a file the task's paths select, such as test
		// configuration. The workspace's manifest and lockfile count only as far as the crate's closure reads them.
		return (
			(dir === undefined || dir === "") &&
			path !== "Cargo.toml" &&
			path !== "Cargo.lock" &&
			(task.paths?.some((pattern) => matches(pattern, path)) ?? false)
		);
	};
	return files.filter(
		(file) =>
			invalidateAll.some((pattern) => matches(pattern, file.path)) ||
			(reads(file) && !task.exclude.some((pattern) => matches(pattern, file.path))),
	);
}

/** The hex SHA-256 of `material`, which must serialize the same way for the same inputs. */
export function digest(material: unknown): string {
	return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** A pass recorded for a digest. */
export interface TaskResult {
	task: string;
	crate: string | null;
	/** How long the run that recorded it took. */
	seconds: number;
	/** The reports it wrote, by the name `--report` gives each copy, in base64 so any encoding replays as it was. */
	reports: { name: string; base64: string }[];
}

/** The cache's size bound; past it, the least recently used passes go first. */
const LIMIT = 256 * 1024 * 1024;

/**
 * This user's task cache, at `$XDG_CACHE_HOME/quest/tasks`, else `~/.cache/quest/tasks`. A pass it holds is
 * trusted as if the task ran, so it refuses a directory another user owns or can write.
 */
export function taskCache(env: NodeJS.ProcessEnv): DiskCache<TaskResult> {
	const directory = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "quest", "tasks");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = statSync(directory);
	if (process.getuid !== undefined && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))
		throw new Error(
			`${directory} must belong to this user and be writable by no one else, since quest run trusts every pass it holds`,
		);
	return diskCache(directory, parseResult, LIMIT);
}

function parseResult(value: unknown): TaskResult | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { task, crate, seconds, reports } = value as Record<string, unknown>;
	if (typeof task !== "string" || (crate !== null && typeof crate !== "string") || typeof seconds !== "number")
		return undefined;
	if (
		!Array.isArray(reports) ||
		!reports.every(
			(report) =>
				typeof report === "object" &&
				report !== null &&
				typeof report.name === "string" &&
				typeof report.base64 === "string",
		)
	)
		return undefined;
	return { task, crate: crate as string | null, seconds, reports };
}
