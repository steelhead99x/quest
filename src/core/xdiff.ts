// The line diffs and three-way merge git runs, ported from git's xdiff
// (xprepare.c, xdiffi.c, xhistogram.c, xmerge.c) so the core merges a file
// exactly as git does without spawning it: the merge driver and a merge queue
// that cannot run git then agree byte for byte.
//
// Two diffs are ported: the Myers diff `git merge-file` runs, and the histogram
// diff `git merge` and GitHub's merges run through merge-ort by default, each
// with xdiff's default heuristics and no whitespace or indent options. The
// merge is at XDL_MERGE_EAGER, the most a diff3-style merge refines. Names
// follow xdiff's so the two can be read side by side.

/** One run of changed lines: `chg1` lines at `i1` in the old file became `chg2` lines at `i2` in the new one. */
export interface Change {
	i1: number;
	i2: number;
	chg1: number;
	chg2: number;
}

/** A region of the merge where at least one side changed the base, with its extent in each version. */
export interface Region {
	/** 0 when the sides conflict, 1 when only ours changed it, 2 when only theirs did. */
	mode: 0 | 1 | 2;
	i0: number;
	chg0: number;
	i1: number;
	chg1: number;
	i2: number;
	chg2: number;
}

const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_LINE_MAX = Number.MAX_SAFE_INTEGER;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;
const XDL_KPDIS_RUN = 4;

/** A file's lines, each with its `\n`; only the last may lack one, as xdiff records them. */
export function records(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
		out.push(text.slice(start, end + 1));
		start = end + 1;
	}
	if (start < text.length) out.push(text.slice(start));
	return out;
}

/** xdl_bogosqrt: a power of two near the square root, as xdiff bounds its work. */
function bogosqrt(n: number): number {
	let i = 1;
	for (; n > 0; n = Math.floor(n / 4)) i *= 2;
	return i;
}

/** A file prepared for diffing: its lines' classes, and which lines changed, indexed from -1 to `nrec`. */
class File {
	readonly nrec: number;
	/** Each line's class: equal lines share one. */
	readonly ha: Int32Array;
	/** Whether each line changed, offset by one so index -1 and `nrec` read as unchanged sentinels. */
	readonly #rchg: Uint8Array;
	/** The lines the Myers pass compares, by index, and their classes. */
	rindex: Int32Array = new Int32Array(0);
	hr: Int32Array = new Int32Array(0);
	nreff = 0;
	dstart = 0;
	dend = -1;

	constructor(ha: Int32Array) {
		this.nrec = ha.length;
		this.ha = ha;
		this.#rchg = new Uint8Array(ha.length + 2);
	}

	rchg(i: number): number {
		return this.#rchg[i + 1];
	}

	set(i: number, value: number): void {
		this.#rchg[i + 1] = value;
	}
}

/** A line diff: Myers, as `git merge-file` runs it, or histogram, as merge-ort does. */
export type Algorithm = "myers" | "histogram";

/** xdl_prepare_env: each line's class, equal lines sharing one, numbered as they first appear in `a`, then `b`. */
function classify(a: string[], b: string[]): { x1: File; x2: File; len1: number[]; len2: number[] } {
	const classes = new Map<string, number>();
	const len1: number[] = [];
	const len2: number[] = [];
	const ids = (lines: string[], counts: number[]) =>
		Int32Array.from(lines, (line) => {
			let id = classes.get(line);
			if (id === undefined) {
				id = classes.size;
				classes.set(line, id);
				len1.push(0);
				len2.push(0);
			}
			counts[id]++;
			return id;
		});
	return { x1: new File(ids(a, len1)), x2: new File(ids(b, len2)), len1, len2 };
}

/** xdl_prepare_env and xdl_optimize_ctxs for Myers: classify lines, trim common ends, and discard lines Myers need not see. */
function prepare(a: string[], b: string[]): [File, File] {
	const { x1, x2, len1, len2 } = classify(a, b);

	// xdl_trim_ends
	const lim = Math.min(x1.nrec, x2.nrec);
	let i = 0;
	while (i < lim && x1.ha[i] === x2.ha[i]) i++;
	x1.dstart = x2.dstart = i;
	let j = 0;
	while (j < lim - i && x1.ha[x1.nrec - 1 - j] === x2.ha[x2.nrec - 1 - j]) j++;
	x1.dend = x1.nrec - j - 1;
	x2.dend = x2.nrec - j - 1;

	// xdl_cleanup_records
	const mark = (x: File, other: number[]) => {
		const mlim = Math.min(bogosqrt(x.nrec), XDL_MAX_EQLIMIT);
		const dis = new Uint8Array(x.nrec + 1);
		for (let k = x.dstart; k <= x.dend; k++) {
			const nm = other[x.ha[k]];
			dis[k] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
		}
		return dis;
	};
	const dis1 = mark(x1, len2);
	const dis2 = mark(x2, len1);
	for (const [x, dis] of [
		[x1, dis1],
		[x2, dis2],
	] as const) {
		const rindex: number[] = [];
		for (let k = x.dstart; k <= x.dend; k++) {
			if (dis[k] === 1 || (dis[k] === 2 && !cleanMmatch(dis, k, x.dstart, x.dend))) rindex.push(k);
			else x.set(k, 1);
		}
		x.rindex = Int32Array.from(rindex);
		x.hr = Int32Array.from(rindex, (k) => x.ha[k]);
		x.nreff = rindex.length;
	}
	return [x1, x2];
}

/** xdl_clean_mmatch: whether a line with many matches sits among lines with none, so it is discarded too. */
function cleanMmatch(dis: Uint8Array, i: number, s: number, e: number): boolean {
	if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW;
	if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW;
	let rdis0 = 0;
	let rpdis0 = 1;
	for (let r = 1; i - r >= s; r++) {
		if (!dis[i - r]) rdis0++;
		else if (dis[i - r] === 2) rpdis0++;
		else break;
	}
	if (rdis0 === 0) return false;
	let rdis1 = 0;
	let rpdis1 = 1;
	for (let r = 1; i + r <= e; r++) {
		if (!dis[i + r]) rdis1++;
		else if (dis[i + r] === 2) rpdis1++;
		else break;
	}
	if (rdis1 === 0) return false;
	rdis1 += rdis0;
	rpdis1 += rpdis0;
	return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1;
}

interface Split {
	i1: number;
	i2: number;
	minLo: boolean;
	minHi: boolean;
}

/** The forward and backward diagonals' furthest reach, indexed by diagonal plus `off`. */
interface Kv {
	f: Float64Array;
	b: Float64Array;
	off: number;
}

/** xdl_split: the middle snake of the box, or a heuristic cut when the edit cost grows too large. */
function split(
	ha1: Int32Array,
	off1: number,
	lim1: number,
	ha2: Int32Array,
	off2: number,
	lim2: number,
	kv: Kv,
	needMin: boolean,
	mxcost: number,
): Split {
	const { f, b, off } = kv;
	const dmin = off1 - lim2;
	const dmax = lim1 - off2;
	const fmid = off1 - off2;
	const bmid = lim1 - lim2;
	const odd = ((fmid - bmid) & 1) !== 0;
	let fmin = fmid;
	let fmax = fmid;
	let bmin = bmid;
	let bmax = bmid;

	f[fmid + off] = off1;
	b[bmid + off] = lim1;

	for (let ec = 1; ; ec++) {
		let gotSnake = false;

		if (fmin > dmin) f[--fmin - 1 + off] = -1;
		else ++fmin;
		if (fmax < dmax) f[++fmax + 1 + off] = -1;
		else --fmax;

		for (let d = fmax; d >= fmin; d -= 2) {
			let i1 = f[d - 1 + off] >= f[d + 1 + off] ? f[d - 1 + off] + 1 : f[d + 1 + off];
			const prev1 = i1;
			let i2 = i1 - d;
			for (; i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]; i1++, i2++);
			if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = true;
			f[d + off] = i1;
			if (odd && bmin <= d && d <= bmax && b[d + off] <= i1) return { i1, i2, minLo: true, minHi: true };
		}

		if (bmin > dmin) b[--bmin - 1 + off] = XDL_LINE_MAX;
		else ++bmin;
		if (bmax < dmax) b[++bmax + 1 + off] = XDL_LINE_MAX;
		else --bmax;

		for (let d = bmax; d >= bmin; d -= 2) {
			let i1 = b[d - 1 + off] < b[d + 1 + off] ? b[d - 1 + off] : b[d + 1 + off] - 1;
			const prev1 = i1;
			let i2 = i1 - d;
			for (; i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]; i1--, i2--);
			if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = true;
			b[d + off] = i1;
			if (!odd && fmin <= d && d <= fmax && i1 <= f[d + off]) return { i1, i2, minLo: true, minHi: true };
		}

		if (needMin) continue;

		// A costly edit with a long snake: cut at the diagonal furthest along it.
		if (gotSnake && ec > XDL_HEUR_MIN_COST) {
			let best = 0;
			let cut: Split | null = null;
			for (let d = fmax; d >= fmin; d -= 2) {
				const dd = d > fmid ? d - fmid : fmid - d;
				const i1 = f[d + off];
				const i2 = i1 - d;
				const v = i1 - off1 + (i2 - off2) - dd;
				if (
					v > XDL_K_HEUR * ec &&
					v > best &&
					off1 + XDL_SNAKE_CNT <= i1 &&
					i1 < lim1 &&
					off2 + XDL_SNAKE_CNT <= i2 &&
					i2 < lim2
				) {
					for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++)
						if (k === XDL_SNAKE_CNT) {
							best = v;
							cut = { i1, i2, minLo: true, minHi: false };
							break;
						}
				}
			}
			if (cut !== null) return cut;

			best = 0;
			for (let d = bmax; d >= bmin; d -= 2) {
				const dd = d > bmid ? d - bmid : bmid - d;
				const i1 = b[d + off];
				const i2 = i1 - d;
				const v = lim1 - i1 + (lim2 - i2) - dd;
				if (
					v > XDL_K_HEUR * ec &&
					v > best &&
					off1 < i1 &&
					i1 <= lim1 - XDL_SNAKE_CNT &&
					off2 < i2 &&
					i2 <= lim2 - XDL_SNAKE_CNT
				) {
					for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++)
						if (k === XDL_SNAKE_CNT - 1) {
							best = v;
							cut = { i1, i2, minLo: false, minHi: true };
							break;
						}
				}
			}
			if (cut !== null) return cut;
		}

		// Enough is enough: cut at the furthest-reaching path.
		if (ec >= mxcost) {
			let fbest = -1;
			let fbest1 = -1;
			for (let d = fmax; d >= fmin; d -= 2) {
				let i1 = Math.min(f[d + off], lim1);
				let i2 = i1 - d;
				if (lim2 < i2) {
					i1 = lim2 + d;
					i2 = lim2;
				}
				if (fbest < i1 + i2) {
					fbest = i1 + i2;
					fbest1 = i1;
				}
			}
			let bbest = XDL_LINE_MAX;
			let bbest1 = XDL_LINE_MAX;
			for (let d = bmax; d >= bmin; d -= 2) {
				let i1 = Math.max(off1, b[d + off]);
				let i2 = i1 - d;
				if (i2 < off2) {
					i1 = off2 + d;
					i2 = off2;
				}
				if (i1 + i2 < bbest) {
					bbest = i1 + i2;
					bbest1 = i1;
				}
			}
			if (lim1 + lim2 - bbest < fbest - (off1 + off2))
				return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false };
			return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
		}
	}
}

/** xdl_recs_cmp: mark the changed lines in the box, dividing at the middle snake. */
function compare(
	x1: File,
	off1: number,
	lim1: number,
	x2: File,
	off2: number,
	lim2: number,
	kv: Kv,
	needMin: boolean,
	mxcost: number,
): void {
	const ha1 = x1.hr;
	const ha2 = x2.hr;
	for (; off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]; off1++, off2++);
	for (; off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]; lim1--, lim2--);

	if (off1 === lim1) {
		for (; off2 < lim2; off2++) x2.set(x2.rindex[off2], 1);
	} else if (off2 === lim2) {
		for (; off1 < lim1; off1++) x1.set(x1.rindex[off1], 1);
	} else {
		const spl = split(ha1, off1, lim1, ha2, off2, lim2, kv, needMin, mxcost);
		compare(x1, off1, spl.i1, x2, off2, spl.i2, kv, spl.minLo, mxcost);
		compare(x1, spl.i1, lim1, x2, spl.i2, lim2, kv, spl.minHi, mxcost);
	}
}

/** A run of changed lines in one file, `start` up to but not including `end`. */
interface Group {
	start: number;
	end: number;
}

function groupInit(x: File): Group {
	const g = { start: 0, end: 0 };
	while (x.rchg(g.end)) g.end++;
	return g;
}

function groupNext(x: File, g: Group): boolean {
	if (g.end === x.nrec) return false;
	g.start = g.end + 1;
	for (g.end = g.start; x.rchg(g.end); g.end++);
	return true;
}

function groupPrevious(x: File, g: Group): boolean {
	if (g.start === 0) return false;
	g.end = g.start - 1;
	for (g.start = g.end; x.rchg(g.start - 1); g.start--);
	return true;
}

function groupSlideDown(x: File, g: Group): boolean {
	if (g.end < x.nrec && x.ha[g.start] === x.ha[g.end]) {
		x.set(g.start++, 0);
		x.set(g.end++, 1);
		while (x.rchg(g.end)) g.end++;
		return true;
	}
	return false;
}

function groupSlideUp(x: File, g: Group): boolean {
	if (g.start > 0 && x.ha[g.start - 1] === x.ha[g.end - 1]) {
		x.set(--g.start, 1);
		x.set(--g.end, 0);
		while (x.rchg(g.start - 1)) g.start--;
		return true;
	}
	return false;
}

/**
 * xdl_change_compact without the indent heuristic: slide each group of changes down, then back up to meet one in the
 * other file. A histogram diff then diffs a group that moved again with Myers, since merging groups may have lined up
 * equal lines.
 */
function compact(x: File, xo: File, algorithm: Algorithm): void {
	const g = groupInit(x);
	const go = groupInit(xo);
	const sync = (moved: boolean) => {
		if (!moved) throw new Error("xdiff: group sync broken");
	};
	for (;;) {
		if (g.end !== g.start) {
			const orig = { ...g };
			let groupsize: number;
			let earliestEnd: number;
			let endMatchingOther: number;
			do {
				groupsize = g.end - g.start;
				endMatchingOther = -1;
				while (groupSlideUp(x, g)) sync(groupPrevious(xo, go));
				earliestEnd = g.end;
				if (go.end > go.start) endMatchingOther = g.end;
				while (groupSlideDown(x, g)) {
					sync(groupNext(xo, go));
					if (go.end > go.start) endMatchingOther = g.end;
				}
			} while (groupsize !== g.end - g.start);

			if (g.end !== earliestEnd && endMatchingOther !== -1) {
				while (go.end === go.start) {
					sync(groupSlideUp(x, g));
					sync(groupPrevious(xo, go));
				}
			}
			if (go.end !== go.start && algorithm === "histogram" && (g.start !== orig.start || g.end !== orig.end))
				fallBack(x, xo, g.start + 1, g.end - g.start, go.start + 1, go.end - go.start);
		}
		if (!groupNext(x, g)) break;
		sync(groupNext(xo, go));
	}
}

/** The Myers diff of `a` and `b`, before compaction, as xdl_do_diff leaves it. */
function myers(a: string[], b: string[]): [File, File] {
	const [x1, x2] = prepare(a, b);
	const ndiags = x1.nreff + x2.nreff + 3;
	const kv = { f: new Float64Array(ndiags), b: new Float64Array(ndiags), off: x2.nreff + 1 };
	const mxcost = Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN);
	compare(x1, 0, x1.nreff, x2, 0, x2.nreff, kv, false, mxcost);
	return [x1, x2];
}

/** The changes from `a` to `b`, in order, as git's `algorithm` finds them. */
export function diff(a: string[], b: string[], algorithm: Algorithm = "myers"): Change[] {
	const [x1, x2] = algorithm === "myers" ? myers(a, b) : histogram(a, b);
	compact(x1, x2, algorithm);
	compact(x2, x1, algorithm);

	// xdl_build_script, walking back from the end.
	const out: Change[] = [];
	for (let i1 = x1.nrec, i2 = x2.nrec; i1 >= 0 || i2 >= 0; i1--, i2--) {
		if (x1.rchg(i1 - 1) || x2.rchg(i2 - 1)) {
			const l1 = i1;
			const l2 = i2;
			while (x1.rchg(i1 - 1)) i1--;
			while (x2.rchg(i2 - 1)) i2--;
			out.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
		}
	}
	return out.reverse();
}

/** Git's histogram diff gave up on a pair of files, so git cannot merge them by lines. */
export class HistogramFailure extends Error {}

/** xdl_fall_back_diff: Myers over lines `line1` and `line2` on, 1-based, `count1` and `count2` long, uncompacted. */
function fallBack(x1: File, x2: File, line1: number, count1: number, line2: number, count2: number): void {
	// Each line's class stands for its text: equal exactly when the lines are.
	const lines = (x: File, line: number, count: number) =>
		Array.from(x.ha.subarray(line - 1, line - 1 + count), (id) => `${id}`);
	const [s1, s2] = myers(lines(x1, line1, count1), lines(x2, line2, count2));
	for (let i = 0; i < count1; i++) x1.set(line1 - 1 + i, s1.rchg(i));
	for (let i = 0; i < count2; i++) x2.set(line2 - 1 + i, s2.rchg(i));
}

/** xhistogram.c's limit on distinct lines sharing a hash bucket, and on how often a line it anchors on occurs. */
const MAX_CHAIN_LENGTH = 64;

/** A class's occurrences in the range: its first line, 1-based, and how many there are. */
interface Occurrence {
	ptr: number;
	cnt: number;
}

/** xdl_do_histogram_diff: the histogram diff of `a` and `b` over every line, with no ends trimmed. */
function histogram(a: string[], b: string[]): [File, File] {
	const { x1, x2 } = classify(a, b);
	histogramDiff(x1, x2, 1, x1.nrec, 1, x2.nrec);
	return [x1, x2];
}

/** histogram_diff over lines `line1` and `line2` on, 1-based, `count1` and `count2` long. */
function histogramDiff(x1: File, x2: File, line1: number, count1: number, line2: number, count2: number): void {
	const all = () => {
		for (let i = 0; i < count1; i++) x1.set(line1 - 1 + i, 1);
		for (let i = 0; i < count2; i++) x2.set(line2 - 1 + i, 1);
	};
	for (;;) {
		if (count1 <= 0 && count2 <= 0) return;
		if (count1 === 0 || count2 === 0) return all();
		const lcs = findLcs(x1, x2, line1, count1, line2, count2);
		if (lcs === null) return fallBack(x1, x2, line1, count1, line2, count2);
		if (lcs.begin1 === 0 && lcs.begin2 === 0) return all();
		histogramDiff(x1, x2, line1, lcs.begin1 - line1, line2, lcs.begin2 - line2);
		// The rest after the common run, as git's tail call.
		count1 = line1 + count1 - 1 - lcs.end1;
		line1 = lcs.end1 + 1;
		count2 = line2 + count2 - 1 - lcs.end2;
		line2 = lcs.end2 + 1;
	}
}

/**
 * find_lcs: the longest common run anchored on the rarest lines the ranges share, all zero when they share none, or
 * null when every shared line occurs too often to anchor on, so Myers diffs the ranges instead.
 */
function findLcs(
	x1: File,
	x2: File,
	line1: number,
	count1: number,
	line2: number,
	count2: number,
): { begin1: number; end1: number; begin2: number; end2: number } | null {
	const end1 = line1 + count1 - 1;
	const end2 = line2 + count2 - 1;
	// xdl_hashbits and XDL_HASHLONG, so lines share buckets as in git, which gives up on a full bucket.
	let bits = 0;
	for (let val = 1; val < count1 && bits < 32; val *= 2) bits++;
	bits ||= 1;
	const mask = 2 ** bits - 1;
	const hash = (id: number) => (id + Math.floor(id / 2 ** bits)) & mask;
	const buckets: Occurrence[][] = Array.from({ length: 2 ** bits }, () => []);
	const lineMap: Occurrence[] = new Array(count1);
	// Each line's next occurrence of its class, 0 for none.
	const nextPtrs = new Int32Array(count1);
	const cmp = (l1: number, l2: number) => x1.ha[l1 - 1] === x2.ha[l2 - 1];

	// scanA, from the last line up, so each class's chain starts at its first line.
	for (let ptr = end1; ptr >= line1; ptr--) {
		const bucket = buckets[hash(x1.ha[ptr - 1]!)]!;
		const rec = bucket.find((each) => x1.ha[each.ptr - 1] === x1.ha[ptr - 1]);
		if (rec !== undefined) {
			nextPtrs[ptr - line1] = rec.ptr;
			rec.ptr = ptr;
			rec.cnt++;
			lineMap[ptr - line1] = rec;
			continue;
		}
		if (bucket.length === MAX_CHAIN_LENGTH)
			throw new HistogramFailure("a hash bucket holds too many distinct lines");
		const created = { ptr, cnt: 1 };
		// Git's chains list the newest class first.
		bucket.unshift(created);
		lineMap[ptr - line1] = created;
	}

	const lcs = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
	let cnt = MAX_CHAIN_LENGTH + 1;
	let hasCommon = false;
	const occurrences = (ptr: number) => lineMap[ptr - line1]!.cnt;
	for (let bPtr = line2; bPtr <= end2;) {
		// try_lcs
		let bNext = bPtr + 1;
		for (const rec of buckets[hash(x2.ha[bPtr - 1]!)]!) {
			if (rec.cnt > cnt) {
				if (!hasCommon) hasCommon = cmp(rec.ptr, bPtr);
				continue;
			}
			let as = rec.ptr;
			if (!cmp(as, bPtr)) continue;
			hasCommon = true;
			for (;;) {
				let np = nextPtrs[as - line1]!;
				let bs = bPtr;
				let ae = as;
				let be = bs;
				let rc = rec.cnt;
				while (line1 < as && line2 < bs && cmp(as - 1, bs - 1)) {
					as--;
					bs--;
					if (1 < rc) rc = Math.min(rc, occurrences(as));
				}
				while (ae < end1 && be < end2 && cmp(ae + 1, be + 1)) {
					ae++;
					be++;
					if (1 < rc) rc = Math.min(rc, occurrences(ae));
				}
				if (bNext <= be) bNext = be + 1;
				if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) {
					lcs.begin1 = as;
					lcs.begin2 = bs;
					lcs.end1 = ae;
					lcs.end2 = be;
					cnt = rc;
				}
				while (np !== 0 && np <= ae) np = nextPtrs[np - line1]!;
				if (np === 0) break;
				as = np;
			}
		}
		bPtr = bNext;
	}
	return hasCommon && MAX_CHAIN_LENGTH < cnt ? null : lcs;
}

/**
 * xdl_do_merge at XDL_MERGE_EAGER: the regions where ours (`xscr1`, the
 * changes from base to ours) or theirs (`xscr2`) changed the base, merging
 * touching ones, and conflicting where both did unless identically.
 */
export function regions(ours: string[], theirs: string[], nbase: number, xscr1: Change[], xscr2: Change[]): Region[] {
	const out: Region[] = [];
	const append = (mode: 0 | 1 | 2, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number) => {
		const m = out[out.length - 1];
		if (m !== undefined && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
			if (mode !== m.mode) m.mode = 0;
			m.chg0 = i0 + chg0 - m.i0;
			m.chg1 = i1 + chg1 - m.i1;
			m.chg2 = i2 + chg2 - m.i2;
		} else {
			out.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
		}
	};
	const same = (i1: number, i2: number, n: number) => {
		for (let k = 0; k < n; k++) if (ours[i1 + k] !== theirs[i2 + k]) return false;
		return true;
	};

	let a = 0;
	let b = 0;
	while (a < xscr1.length && b < xscr2.length) {
		const s1 = xscr1[a];
		const s2 = xscr2[b];
		if (s1.i1 + s1.chg1 < s2.i1) {
			append(1, s1.i1, s1.chg1, s1.i2, s1.chg2, s2.i2 - s2.i1 + s1.i1, s1.chg1);
			a++;
			continue;
		}
		if (s2.i1 + s2.chg1 < s1.i1) {
			append(2, s2.i1, s2.chg1, s1.i2 - s1.i1 + s2.i1, s2.chg1, s2.i2, s2.chg2);
			b++;
			continue;
		}
		if (s1.i1 !== s2.i1 || s1.chg1 !== s2.chg1 || s1.chg2 !== s2.chg2 || !same(s1.i2, s2.i2, s1.chg2)) {
			const off = s1.i1 - s2.i1;
			const ffo = off + s1.chg1 - s2.chg1;
			let i0 = s1.i1;
			let i1 = s1.i2;
			let i2 = s2.i2;
			if (off > 0) {
				i0 -= off;
				i1 -= off;
			} else {
				i2 += off;
			}
			let chg0 = s1.i1 + s1.chg1 - i0;
			let chg1 = s1.i2 + s1.chg2 - i1;
			let chg2 = s2.i2 + s2.chg2 - i2;
			if (ffo < 0) {
				chg0 -= ffo;
				chg1 -= ffo;
			} else {
				chg2 += ffo;
			}
			append(0, i0, chg0, i1, chg1, i2, chg2);
		}
		const end1 = s1.i1 + s1.chg1;
		const end2 = s2.i1 + s2.chg1;
		if (end1 >= end2) b++;
		if (end2 >= end1) a++;
	}
	for (; a < xscr1.length; a++) {
		const s1 = xscr1[a];
		append(1, s1.i1, s1.chg1, s1.i2, s1.chg2, s1.i1 + theirs.length - nbase, s1.chg1);
	}
	for (; b < xscr2.length; b++) {
		const s2 = xscr2[b];
		append(2, s2.i1, s2.chg1, s2.i1 + ours.length - nbase, s2.chg1, s2.i2, s2.chg2);
	}
	return out;
}
