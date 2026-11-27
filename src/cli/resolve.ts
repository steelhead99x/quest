// `quest resolve`: the merge driver for quest files. The core merges by line,
// as git does, then resolves the conflicts that only edit a link list.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { LABELS, merge, render, resolveLists } from "../core";

/** Git's default conflict marker length. */
const MARKER_SIZE = 7;

/**
 * The command `merge.quest.driver` runs. Git substitutes its temporary file
 * names for `%A`, `%O`, and `%B` and runs it with a shell. A `quest` missing
 * from the merge's PATH, or one without `resolve`, falls back to git's own
 * merge with conflict markers: `quest help <unknown>` exits non-zero, while
 * `quest <unknown> --help` prints the top-level help and exits zero. A
 * fallback that leaves conflicts says why on stderr, naming the file (`%P`),
 * since those markers may be link-list edits `quest resolve` would have
 * merged. Git keeps a placeholder it does not know, such as printf's `%s`.
 */
export const DRIVER =
	"if quest help resolve >/dev/null 2>&1; " +
	"then quest resolve %A %O %B --marker-size=%L --ours-label=%X --base-label=%S --theirs-label=%Y; " +
	'quest_merge_status=$?; if [ "$quest_merge_status" -le 1 ]; then exit "$quest_merge_status"; fi; ' +
	"quest_merge_reason='quest resolve failed'; else quest_merge_reason='no quest resolve on PATH'; fi; " +
	"git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B && exit 0; quest_merge_status=$?; " +
	"printf 'quest: %s, so link lists in %s were not auto-resolved\\n' \"$quest_merge_reason\" %P >&2; " +
	'exit "$quest_merge_status"';

/**
 * Drivers earlier quest versions registered. A clone that kept one is upgraded to `DRIVER`, while
 * any other string, a custom driver, is left alone. When `DRIVER` changes, add its old value here.
 */
export const OLD_DRIVERS: readonly string[] = [
	// kixel-ai/quest#219
	"if quest help resolve >/dev/null 2>&1; then quest resolve %A %O %B; " +
		"else git merge-file -L ours -L base -L theirs %A %O %B; fi",
	// kixel-ai/quest#256
	"if quest help resolve >/dev/null 2>&1; " +
		"then quest resolve %A %O %B --marker-size=%L --ours-label=%X --base-label=%S --theirs-label=%Y; " +
		'quest_merge_status=$?; if [ "$quest_merge_status" -le 1 ]; then exit "$quest_merge_status"; fi; fi; ' +
		"git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B",
];

export interface ResolveOptions {
	markerSize?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
}

/**
 * Merge `theirs` into `ours` from their common `base`, as `git merge-file`
 * does, writing the result to `ours`. Returns how many conflicts remain.
 * Refuses, as git does, a file that looks binary, and one that is not UTF-8,
 * so the driver falls back to git's own merge rather than rewrite its bytes.
 */
export function resolveFile(ours: string, base: string, theirs: string, options: ResolveOptions = {}): number {
	const markerSize = options.markerSize ?? MARKER_SIZE;
	if (!Number.isSafeInteger(markerSize) || markerSize <= 0)
		throw new Error("marker size must be a positive safe integer");
	const labels = {
		ours: options.oursLabel ?? LABELS.ours,
		base: options.baseLabel ?? LABELS.base,
		theirs: options.theirsLabel ?? LABELS.theirs,
	};
	if (Object.values(labels).some((label) => /[\r\n]/.test(label)))
		throw new Error("conflict labels must be single lines");
	const [o, b, t] = [ours, base, theirs].map((file) => {
		const bytes = readFileSync(file);
		// Git's own test for a binary file: a NUL in its first 8000 bytes.
		if (bytes.subarray(0, 8000).includes(0)) throw new Error(`cannot merge binary file ${file}`);
		try {
			return UTF8.decode(bytes);
		} catch {
			throw new Error(`cannot merge ${file}: not UTF-8`);
		}
	});

	const resolved = resolveLists(ours, merge(o, b, t));
	writeFileSync(ours, render(resolved, markerSize, diff3(), labels));
	return resolved.filter((chunk) => !Array.isArray(chunk)).length;
}

/** Strict, and keeping a byte order mark, so the text written back is the bytes read. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Whether unresolved conflicts show the base too, as `merge.conflictStyle` says. */
function diff3(): boolean {
	const style = spawnSync("git", ["config", "--get", "merge.conflictStyle"], { encoding: "utf8" });
	return ["diff3", "zdiff3"].includes(style.stdout?.trim() ?? "");
}
