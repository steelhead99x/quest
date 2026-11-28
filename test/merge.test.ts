// The core's line merge against `git merge-file --diff3`, which it ports.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { merge, render } from "../src/core";
import { type Change, diff } from "../src/core/xdiff";
import { tempDir } from "./fixture";

/** Git's merge of the three texts, with the markers `render` writes by default. */
function git(ours: string, base: string, theirs: string): string {
	const dir = tempDir();
	const [o, b, t] = ["ours", "base", "theirs"].map((name) => join(dir, name));
	writeFileSync(o, ours);
	writeFileSync(b, base);
	writeFileSync(t, theirs);
	const merged = spawnSync(
		"git",
		["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", o, b, t],
		{ encoding: "utf8" },
	);
	if (merged.status === null || merged.status > 127) throw new Error(merged.stderr);
	return merged.stdout;
}

/**
 * Git's histogram merge of the three texts, as merge-ort runs it: its clean text, or null when it conflicts. Its
 * conflict level is not merge-ort's, which shapes conflicts differently but leaves the same files clean.
 */
function histogram(ours: string, base: string, theirs: string): string | null {
	const dir = tempDir();
	const [o, b, t] = ["ours", "base", "theirs"].map((name) => join(dir, name));
	writeFileSync(o, ours);
	writeFileSync(b, base);
	writeFileSync(t, theirs);
	const merged = spawnSync("git", ["merge-file", "-p", "--diff-algorithm=histogram", o, b, t], {
		encoding: "utf8",
	});
	if (merged.status === null || merged.status < 0 || merged.status > 127) throw new Error(merged.stderr);
	return merged.status === 0 ? merged.stdout : null;
}

/** Git's histogram diff of two texts, as the changes `diff` returns, read from its zero-context hunk headers. */
function gitHistogram(a: string, b: string): Change[] {
	const dir = tempDir();
	writeFileSync(join(dir, "a"), a);
	writeFileSync(join(dir, "b"), b);
	const args = ["diff", "--no-index", "--histogram", "--no-indent-heuristic", "-U0", "a", "b"];
	const out = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	if (out.status !== 0 && out.status !== 1) throw new Error(out.stderr);
	return [...out.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
		const [chg1, chg2] = [Number(m[2] ?? 1), Number(m[4] ?? 1)];
		// An empty side names the line before it.
		return { i1: Number(m[1]) - (chg1 === 0 ? 0 : 1), i2: Number(m[3]) - (chg2 === 0 ? 0 : 1), chg1, chg2 };
	});
}

/** The core's merge as merge-ort's: its clean text, or null when it conflicts. */
function ort(ours: string, base: string, theirs: string): string | null {
	const chunks = merge(ours, base, theirs, "ort");
	return chunks.every((chunk) => Array.isArray(chunk)) ? render(chunks, 7, false) : null;
}

/** A deterministic generator, so a failure reproduces from its seed. */
function random(seed: number): (n: number) => number {
	let state = seed >>> 0 || 1;
	return (n) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % n;
	};
}

/**
 * Lines from a small vocabulary heavy in blank and repeated lines, which is
 * where diffs have ties for git's discards and sliding to break.
 */
const VOCABULARY = [
	"",
	"",
	"",
	"a",
	"b",
	"c",
	"d",
	"- [x](/quest/x.md)",
	"- [y](/quest/y.md)",
	"## Required",
	"}",
	// CRLF lines, which decide a conflict's marker endings.
	"\r",
	"a\r",
	"b\r",
];

function text(next: (n: number) => number, lines: string[]): string {
	const body = lines.join("\n");
	// Most files end with a newline; some do not, which git merges as a different last line.
	return lines.length === 0 || next(4) === 0 ? body : `${body}\n`;
}

/** `base` with a few random insertions, deletions, and replacements. */
function edit(next: (n: number) => number, base: string[]): string[] {
	const out = [...base];
	for (let edits = next(4); edits > 0; edits--) {
		const at = next(out.length + 1);
		const op = next(3);
		if (op === 0 || out.length === 0) out.splice(at, 0, ...Array.from({ length: 1 + next(3) }, () => word(next)));
		else if (op === 1) out.splice(at, 1 + next(3));
		else out.splice(at, 1, word(next));
	}
	return out;
}

function word(next: (n: number) => number): string {
	return VOCABULARY[next(VOCABULARY.length)];
}

describe("merge", () => {
	test("matches git merge-file --diff3 on random edits", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const next = random(seed);
			const base = Array.from({ length: next(25) }, () => word(next));
			const [o, b, t] = [text(next, edit(next, base)), text(next, base), text(next, edit(next, base))];
			expect(render(merge(o, b, t), 7, true), `seed ${seed}`).toBe(git(o, b, t));
		}
	});

	test("merges as git's histogram merge does on random edits, and differs from merge-file where git does", () => {
		let differs = 0;
		for (let seed = 1; seed <= 1500; seed++) {
			const next = random(seed);
			const base = Array.from({ length: next(25) }, () => word(next));
			const [o, b, t] = [text(next, edit(next, base)), text(next, base), text(next, edit(next, base))];
			const expected = histogram(o, b, t);
			expect(ort(o, b, t), `seed ${seed}`).toBe(expected);
			const myers = merge(o, b, t);
			if ((myers.every((chunk) => Array.isArray(chunk)) ? render(myers, 7, false) : null) !== expected) differs++;
		}
		// The histories reach cases where the two diffs part.
		expect(differs).toBeGreaterThan(0);
	});

	test("diffs as git's histogram diff does, including the groups compaction re-diffs", () => {
		const words = ["a", "b", "c", "", "}", "x"];
		for (let seed = 1; seed <= 400; seed++) {
			const next = random(seed);
			const a = Array.from({ length: 3 + next(10) }, () => `${words[next(words.length)]}\n`);
			const b = [...a];
			for (let k = next(4) + 1; k > 0; k--) {
				const at = next(b.length + 1);
				if (next(2)) b.splice(at, 1);
				else b.splice(at, 0, `${words[next(words.length)]}\n`);
			}
			expect(diff(a, b, "histogram"), `seed ${seed}`).toEqual(gitHistogram(a.join(""), b.join("")));
		}
	});

	test("settles a conflict whose sides end up the same, as merge-ort does and merge-file --diff3 does not", () => {
		// Each found by search: the sides change overlapping base lines differently into the same lines.
		const cases = [
			["x\n\nc\nc\n}\nc\n", "x\nx\n\nb\nc\n}\n}\nc\n", "x\nx\n\nb\n}\nc\n}\nc\n"],
			["b\nb\nx\n}\nb\nx\nb\n", "b\nb\n}\nb\nb\nx\nb\n", "b\n}\nb\nx\nb\n"],
			["c\nc\n}\n}\nc\nb\nc\n", "c\n\n}\nc\nc\nb\nc\n", "c\n\n}\nc\nb\nc\n"],
			["x\nb\nb\nb\n\nb\nc\n", "}\na\nb\n\n\nb\nc\n", "}\na\nb\n\nb\nc\n"],
			["c\nc\nc\n\n}\n}\n", "c\nc\n\n\n}\nx\n}\nx\n", "c\nc\nc\n\n}\nx\n}\nx\n"],
		] as const;
		for (const [o, b, t] of cases) {
			expect(ort(o, b, t)).toBe(histogram(o, b, t));
		}
	});

	test("merges long, mostly rewritten files as git's histogram merge does", () => {
		for (const seed of [7, 8]) {
			const next = random(seed);
			// Few distinct lines, so many occur too often to anchor on and histogram falls back to Myers.
			const base = Array.from({ length: 3000 }, () => String(next(seed === 7 ? 40 : 4)));
			const side = () => base.map((line) => (next(3) === 0 ? String(next(40)) : line));
			const join = (lines: string[]) => `${lines.join("\n")}\n`;
			const [o, b, t] = [join(side()), join(base), join(side())];
			expect(ort(o, b, t), `seed ${seed}`).toBe(histogram(o, b, t));
		}
	});

	test("matches git where its heuristics cut a costly diff", () => {
		// Long files, mostly rewritten, push the edit cost past the point git stops searching for the shortest diff.
		const next = random(7);
		const base = Array.from({ length: 3000 }, () => String(next(40)));
		const side = () => base.map((line) => (next(3) === 0 ? String(next(40)) : line));
		const [o, t] = [side(), side()];
		const join = (lines: string[]) => `${lines.join("\n")}\n`;
		expect(render(merge(join(o), join(base), join(t)), 7, true)).toBe(git(join(o), join(base), join(t)));
	});

	test("ends a CRLF file's conflict markers in CRLF as git does, even after a last line without one", () => {
		const [o, b, t] = ["a\r\nours", "a\r\nbase", "a\r\ntheirs"];
		expect(merge(o, b, t)).toEqual([
			["a\r"],
			{ ours: ["ours\r"], base: ["base\r"], theirs: ["theirs\r"], crlf: true },
			[""],
		]);
		expect(render(merge(o, b, t), 7, true)).toBe(git(o, b, t));
	});

	test("keeps a file both sides left alone, or changed alike", () => {
		expect(merge("a\nb\n", "a\nb\n", "a\nb\n")).toEqual([["a", "b", ""]]);
		expect(merge("a\nx\n", "a\nb\n", "a\nx\n")).toEqual([["a", "x", ""]]);
		expect(merge("", "", "")).toEqual([[""]]);
	});

	test("conflicts on edits that touch, as git does", () => {
		expect(merge("a\nB\nc\n", "a\nb\nc\n", "a\nb\nC\n")).toEqual([
			["a"],
			{ ours: ["B", "c"], base: ["b", "c"], theirs: ["b", "C"], crlf: false },
			[""],
		]);
	});
});
