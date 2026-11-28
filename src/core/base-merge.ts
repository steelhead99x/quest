// Whether a review of one head still covers a later one that only merged the base. A merge of the base that is the
// clean merge of its parents adds nothing of the PR's own, though it changes `git diff <base>...<head>`'s text
// wherever the base touched a file the PR touches. So a review carries along the head's first-parent chain across
// such merges, each checked by redoing it: git's own line merge, ported in `xdiff.ts`, so a merge queue that cannot
// run git judges a head as `quest` does.
//
// A file only one parent changed since their merge base must be that parent's; one both changed must be its clean
// line merge: merge-ort's, as `git merge` and GitHub's update-branch run it, or, where `.gitattributes` gives the path
// the `quest` driver, which a local merge runs, `git merge-file`'s with the quest link lists `resolveLists` settles.
// One way of merging must account for every file: the driver's on each quest path, or merge-ort's on all of them.
// Anything this cannot establish as git's clean merge does not count, so the review stays stale: a binary file,
// another merge driver, a symlink or submodule both changed, a rename one side made of a file the other changed (seen
// here as a delete against an edit), or a path both sides deleted while either side added one, which git may pair as
// a rename it cannot merge.

import { type Chunk, merge, render, resolveLists } from "./merge";
import { HistogramFailure } from "./xdiff";

/** A tree's entry, as git stores it. */
export interface TreeEntry {
	type: "blob" | "tree" | "commit";
	/** Git's mode, such as `100644`, `100755`, `120000`, or `040000`. */
	mode: string;
	oid: string;
}

/** A repository's history, as a forge or a local clone reads it. */
export interface History {
	/** A commit's root tree and parents, the first parent first. */
	commit(sha: string): Promise<{ tree: string; parents: string[] }>;
	/** A tree's entries by name. */
	tree(oid: string): Promise<Map<string, TreeEntry>>;
	/** A blob's bytes. */
	blob(oid: string): Promise<Uint8Array>;
	/** The merge base of two commits, or null when they have none, or several. */
	mergeBase(a: string, b: string): Promise<string | null>;
	/** Whether the PR's base branch reaches `sha`. */
	onBase(sha: string): Promise<boolean>;
}

/**
 * The commits a head's review may come from: the head, then each first parent back across merges of the base that
 * are clean merges of their parents. It reads the chain only as far as asked, once.
 */
export class BaseMerges {
	readonly #history: Cached;
	readonly #chain: string[];
	#ended = false;

	constructor(history: History, head: string) {
		this.#history = new Cached(history);
		this.#chain = [head.toLowerCase()];
	}

	/**
	 * Whether a review of `sha` covers the head: it is the head, or the head only merged the base since. A read that
	 * fails ends the chain where it stands, and throws.
	 */
	async reaches(sha: string): Promise<boolean> {
		const wanted = sha.toLowerCase();
		for (;;) {
			if (this.#chain.includes(wanted)) return true;
			if (this.#ended) return false;
			let next: string | null;
			try {
				next = await this.#step(this.#chain.at(-1)!);
			} catch (error) {
				this.#ended = true;
				throw error;
			}
			if (next === null) this.#ended = true;
			else this.#chain.push(next);
		}
	}

	/** The first parent of `sha` when `sha` is a clean merge of the base, which it is not when the base reaches it. */
	async #step(sha: string): Promise<string | null> {
		const history = this.#history;
		// The commit first, so a head that is no merge, the common case, costs one read.
		const { tree, parents } = await history.commit(sha);
		if (parents.length !== 2) return null;
		const [ours, theirs] = parents as [string, string];
		if ((await history.onBase(sha)) || !(await history.onBase(theirs))) return null;
		const base = await history.mergeBase(ours, theirs);
		if (base === null) return null;
		const [b, o, t] = await Promise.all(
			[base, ours, theirs].map(async (each) => (await history.commit(each)).tree),
		);
		return (await new TreeMerge(history, [b!, o!, t!]).check(tree)) ? ours : null;
	}
}

/** A history that reads each commit, tree, and blob once, since a walk reads the same ones from several commits. */
class Cached implements History {
	readonly #history: History;
	readonly #commits = new Map<string, Promise<{ tree: string; parents: string[] }>>();
	readonly #trees = new Map<string, Promise<Map<string, TreeEntry>>>();
	readonly #blobs = new Map<string, Promise<Uint8Array>>();

	constructor(history: History) {
		this.#history = history;
	}

	commit(sha: string) {
		let found = this.#commits.get(sha);
		if (found === undefined) this.#commits.set(sha, (found = this.#history.commit(sha)));
		return found;
	}

	tree(oid: string) {
		let found = this.#trees.get(oid);
		if (found === undefined) this.#trees.set(oid, (found = this.#history.tree(oid)));
		return found;
	}

	blob(oid: string) {
		let found = this.#blobs.get(oid);
		if (found === undefined) this.#blobs.set(oid, (found = this.#history.blob(oid)));
		return found;
	}

	mergeBase(a: string, b: string) {
		return this.#history.mergeBase(a, b);
	}

	onBase(sha: string) {
		return this.#history.onBase(sha);
	}
}

/** How git merges a path both sides changed, as its `merge` attribute says: by lines, by the `quest` driver, or otherwise. */
type Driver = "text" | "quest" | "other";

/**
 * How a merge took the files both sides changed: as a local merge with the quest driver does, on the paths it drives,
 * or as merge-ort does on every path, as GitHub's merges do.
 */
type Mode = "driver" | "ort";

/** The check of one merge's tree against its parents' trees and their merge base's. */
class TreeMerge {
	readonly #history: History;
	/** The root trees of the merge base, ours, and theirs, whose `.gitattributes` pick a path's driver. */
	readonly #roots: [string, string, string];
	/** The ways of merging that account for every file checked so far. */
	readonly #modes = new Set<Mode>(["driver", "ort"]);
	/** Whether both sides deleted some path. */
	#bothDeleted = false;

	constructor(history: History, roots: [string, string, string]) {
		this.#history = history;
		this.#roots = roots;
	}

	/** Whether `merged`, a root tree, is the clean merge of the roots. */
	async check(merged: string): Promise<boolean> {
		const [base, ours, theirs] = this.#roots;
		if (!(await this.#matches("", base, ours, theirs, merged))) return false;
		if (!this.#bothDeleted) return true;
		return !(await this.#adds(base, ours)) && !(await this.#adds(base, theirs));
	}

	/** Whether `merged` is the clean merge of the directory `path` as `base`, `ours`, and `theirs` hold it; null for none. */
	async #matches(
		path: string,
		base: string | null,
		ours: string | null,
		theirs: string | null,
		merged: string | null,
	): Promise<boolean> {
		const [b, o, t, m] = await Promise.all(
			[base, ours, theirs, merged].map((oid) => (oid === null ? new Map() : this.#history.tree(oid))),
		);
		const names = new Set([...b!.keys(), ...o!.keys(), ...t!.keys(), ...m!.keys()]);
		for (const name of names) {
			const [eb, eo, et, em] = [b, o, t, m].map((tree) => tree!.get(name)) as (TreeEntry | undefined)[];
			const at = path === "" ? name : `${path}/${name}`;
			// One side's change, or the same change on both, is taken whole.
			if (same(eo, et) || same(eo, eb)) {
				if (!same(em, et)) return false;
				// The same change on both sides may delete a path both sides did, even inside a directory.
				if (same(eo, et) && eb !== undefined && !same(eo, eb) && (await this.#deletes(eb, eo)))
					this.#bothDeleted = true;
			} else if (same(et, eb)) {
				if (!same(em, eo)) return false;
			} else if ([eb, eo, et, em].every((entry) => entry === undefined || entry.type === "tree")) {
				// A directory either side deleted merges as an empty one.
				const oids = [eb, eo, et, em].map((entry) => entry?.oid ?? null) as (string | null)[];
				if (!(await this.#matches(at, oids[0]!, oids[1]!, oids[2]!, oids[3]!))) return false;
			} else if (!(await this.#file(at, eb, eo, et, em))) return false;
		}
		return true;
	}

	/** Whether `merged` is the clean line merge of a file both sides changed. */
	async #file(
		path: string,
		base: TreeEntry | undefined,
		ours: TreeEntry | undefined,
		theirs: TreeEntry | undefined,
		merged: TreeEntry | undefined,
	): Promise<boolean> {
		// A file both sides added, or one deleted and the other changed, conflicts.
		if (![base, ours, theirs, merged].every(regular)) return false;
		const [b, o, t, m] = [base!, ours!, theirs!, merged!];
		const mode = o.mode === b.mode ? t.mode : t.mode === b.mode || o.mode === t.mode ? o.mode : null;
		if (m.mode !== mode) return false;
		const driver = await this.#driver(path);
		if (driver === "other") return false;
		const [bt, ot, tt] = await Promise.all(
			[b, o, t].map(async (entry) => text(await this.#history.blob(entry.oid))),
		);
		if (bt === null || ot === null || tt === null) return false;
		const written = await this.#history.blob(m.oid);
		const matches = (chunks: Chunk[]) =>
			chunks.every((chunk) => Array.isArray(chunk)) && equal(ENCODER.encode(render(chunks, 7, false)), written);
		let ort: boolean;
		try {
			ort = matches(merge(ot, bt, tt, "ort"));
		} catch (error) {
			// Git fails such a merge too, so whatever the merge holds was written by hand.
			if (!(error instanceof HistogramFailure)) throw error;
			ort = false;
		}
		// Only a quest path's merge tells the modes apart: the driver runs merge-file's merge with link lists
		// resolved, and without it, as on GitHub, git falls back to its own.
		if (driver !== "quest") return ort;
		if (!ort) this.#modes.delete("ort");
		if (!matches(resolveLists(path, merge(ot, bt, tt)))) this.#modes.delete("driver");
		return this.#modes.size > 0;
	}

	/** Whether `side` lacks a path `base` holds, both entries of one directory. */
	async #deletes(base: TreeEntry, side: TreeEntry | undefined): Promise<boolean> {
		if (side === undefined || (base.type === "tree") !== (side.type === "tree")) return true;
		if (base.type !== "tree" || base.oid === side.oid) return false;
		const [b, s] = await Promise.all([this.#history.tree(base.oid), this.#history.tree(side.oid)]);
		for (const [name, entry] of b) if (await this.#deletes(entry, s.get(name))) return true;
		return false;
	}

	/** Whether the tree `side` holds a path the tree `base` does not. */
	async #adds(base: string, side: string): Promise<boolean> {
		if (base === side) return false;
		const [b, s] = await Promise.all([this.#history.tree(base), this.#history.tree(side)]);
		for (const [name, entry] of s) {
			const old = b.get(name);
			if (old === undefined || (old.type === "tree") !== (entry.type === "tree")) return true;
			if (entry.type === "tree" && (await this.#adds(old.oid, entry.oid))) return true;
		}
		return false;
	}

	/**
	 * How git may merge `path`: `other` when any of the three trees' attributes give it a merge this cannot check,
	 * `quest` when any gives it the quest driver, and otherwise `text`. Commands differ in which tree's attributes git
	 * reads, so each one's must allow the merge.
	 */
	async #driver(path: string): Promise<Driver> {
		const drivers = await Promise.all(this.#roots.map((root) => this.#attribute(root, path)));
		if (drivers.includes("other")) return "other";
		return drivers.includes("quest") ? "quest" : "text";
	}

	/** `path`'s merge driver as the `.gitattributes` files in `root` set it, from the root's down to its own directory's. */
	async #attribute(root: string, path: string): Promise<Driver> {
		const dirs = path.split("/").slice(0, -1);
		let tree: string | null = root;
		let state: Driver = "text";
		let macros: Set<string> | undefined;
		for (let depth = 0; tree !== null && depth <= dirs.length; depth++) {
			const entries = await this.#history.tree(tree);
			const file = entries.get(".gitattributes");
			if (file !== undefined) {
				// Git reads no `.gitattributes` that is a symlink, and a directory or submodule is not one.
				if (!regular(file)) return "other";
				const source = text(await this.#history.blob(file.oid));
				if (source === null) return "other";
				// Macros are defined only at the top level.
				macros ??= depth === 0 ? mergeMacros(source) : new Set(["binary"]);
				const dir = dirs.slice(0, depth).join("/");
				const relative = dir === "" ? path : path.slice(dir.length + 1);
				const set = mergeState(source, relative, macros);
				if (set === "other") return "other";
				if (set !== null) state = set;
			} else macros ??= new Set(["binary"]);
			const next = depth < dirs.length ? entries.get(dirs[depth]!) : undefined;
			tree = next?.type === "tree" ? next.oid : null;
		}
		return state;
	}
}

/**
 * The macros a `.gitattributes` file defines that touch the `merge` attribute, directly or through another macro,
 * with git's built-in `binary`.
 */
function mergeMacros(source: string): Set<string> {
	const found = new Set(["binary"]);
	const definitions = lines(source).flatMap(([pattern, ...attributes]) =>
		pattern!.startsWith("[attr]") ? [{ name: pattern!.slice(6), attributes }] : [],
	);
	for (let grew = true; grew;) {
		grew = false;
		for (const { name, attributes } of definitions)
			if (!found.has(name) && attributes.some((each) => touches(each, found))) {
				found.add(name);
				grew = true;
			}
	}
	return found;
}

/**
 * The driver the last line of `source` that matches `path`, relative to the file's directory, and touches the
 * `merge` attribute gives it, or null when none does. A line this cannot read, such as a quoted pattern or a
 * bracket expression, is `other` when it touches the attribute at all.
 */
function mergeState(source: string, path: string, macros: Set<string>): Driver | null {
	let state: Driver | null = null;
	for (const [pattern, ...attributes] of lines(source)) {
		// Git ignores negated patterns and patterns for directories, which no file matches.
		if (pattern!.startsWith("[attr]") || pattern!.startsWith("!") || pattern!.endsWith("/")) continue;
		const touching = attributes.filter((each) => touches(each, macros));
		if (touching.length === 0) continue;
		const glob = globSource(pattern!);
		// A quoted pattern may hold spaces, so its line splits wrongly and may name any path.
		if (pattern!.startsWith('"')) return "other";
		// A pattern this cannot read exactly, matched loosely: any bracket expression or escape as one character.
		const loosened = glob === null ? loosen(pattern!) : null;
		const loose = glob ?? (loosened === null ? null : globSource(loosened));
		if (loose === null) return "other";
		const name = path.slice(path.lastIndexOf("/") + 1);
		const anchored = pattern!.includes("/");
		if (!new RegExp(`^${loose}$`, "s").test(anchored ? path : name)) continue;
		if (glob === null || touching.length > 1) return "other";
		const [attribute] = touching as [string];
		state =
			attribute === "!merge"
				? "text"
				: attribute === "merge" || attribute === "merge=text"
					? "text"
					: attribute === "merge=quest"
						? "quest"
						: "other";
	}
	return state;
}

/**
 * `pattern` with each bracket expression and escaped character as `?`, which matches any one character, as either
 * matches one; null when a bracket expression never closes.
 */
function loosen(pattern: string): string | null {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "\\") {
			out += "?";
			i++;
		} else if (pattern[i] !== "[") out += pattern[i];
		else {
			// As wildmatch reads one: a `]` first, after any `!` or `^`, is literal, and `[:class:]` holds its own `]`.
			let j = i + 1;
			if (pattern[j] === "!" || pattern[j] === "^") j++;
			if (pattern[j] === "]") j++;
			for (; j < pattern.length && pattern[j] !== "]"; j++) {
				if (pattern.startsWith("[:", j)) {
					const end = pattern.indexOf(":]", j + 2);
					if (end === -1) return null;
					j = end + 1;
				} else if (pattern[j] === "\\") j++;
			}
			if (j >= pattern.length) return null;
			out += "?";
			i = j;
		}
	}
	return out;
}

/** Whether a line's attribute sets, unsets, or clears `merge`, or one of `macros`. */
function touches(attribute: string, macros: Set<string>): boolean {
	const name = attribute.replace(/^[-!]/, "").replace(/=.*$/s, "");
	return name === "merge" || macros.has(name);
}

/** A `.gitattributes` file's lines, each as its whitespace-separated words, without blanks and comments. */
function lines(source: string): string[][] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split(/\s+/));
}

/**
 * A regular expression's source for a `.gitattributes` pattern, without its leading `/`, as git matches it with
 * `*`, `?`, and whole `**` segments; null for a pattern with quoting, escapes, or a bracket expression.
 */
function globSource(pattern: string): string | null {
	if (/["\\[]/.test(pattern)) return null;
	const segments = (pattern.startsWith("/") ? pattern.slice(1) : pattern).split("/");
	return segments
		.map((segment, index) => {
			const last = index === segments.length - 1;
			if (segment === "**") return last ? ".*" : "(?:[^/]*/)*";
			const source = segment
				.replace(/[.+^${}()|\]]/g, "\\$&")
				.replace(/\*+/g, "[^/]*")
				.replace(/\?/g, "[^/]");
			return last ? source : `${source}/`;
		})
		.join("");
}

/** Whether two entries are the same object at the same mode, or both absent. */
function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
}

/** Whether an entry is a file git merges by content, not a symlink or a submodule. */
function regular(entry: TreeEntry | undefined): boolean {
	return entry?.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

// Workers and Node both have these, though the core's types name no runtime's globals.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (
	label: string,
	options: { fatal: boolean; ignoreBOM: boolean },
) => { decode(bytes: Uint8Array): string };

const ENCODER = new TextEncoder();
/** Strict, and keeping a byte order mark, so the text encodes back to the bytes read. */
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A blob's text, or null for one git merges as binary, with a NUL in its first 8000 bytes, or one not in UTF-8. */
function text(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, 8000).includes(0)) return null;
	try {
		return DECODER.decode(bytes);
	} catch {
		return null;
	}
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
