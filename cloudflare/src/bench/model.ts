// What the bench page shows: each merged quest PR's records, read with the
// CLI's own parsers, and rollups by size and by the model that wrote it.

import { parseReview } from "../../../src/core/index.ts";
import { recorded } from "../../../src/cli/models-record.ts";
import type { Merged } from "./load.ts";

/** One merged quest PR's row. */
export interface Row {
	number: number;
	url: string;
	title: string;
	size: string | null;
	/** Each implementing session's model, writer first. */
	models: string[];
	/** The lowest score among the size's reviewers (not the shadow), out of 10. */
	score: number | null;
	/** The most review rounds any reviewer ran. */
	rounds: number | null;
	/** Hours from the claim (the PR opening) to merge. */
	hours: number;
	/** Minutes from the head commit's first check starting to its last finishing. */
	ci: number | null;
	/** Why a record could not be read, when it could not. */
	unreadable: string | null;
}

/** A rollup over rows sharing a size or a writer. */
export interface Rollup {
	key: string;
	pulls: number;
	score: number | null;
	rounds: number | null;
	hours: number | null;
	ci: number | null;
}

/** One PR's row. */
export function row(p: Merged): Row {
	let unreadable: string | null = null;
	const models = recorded(p.body);
	let score: number | null = null;
	let rounds: number | null = null;
	try {
		const reviewers = parseReview(p.body).filter((r) => !r.shadow);
		const scores = reviewers.map((r) => r.score).filter((s): s is number => s !== null);
		const counts = reviewers.map((r) => r.tally?.rounds).filter((n): n is number => n !== undefined);
		score = scores.length ? Math.min(...scores) : null;
		rounds = counts.length ? Math.max(...counts) : null;
	} catch (error) {
		unreadable = (error as Error).message;
	}
	const starts = p.checks.map((c) => Date.parse(c.started ?? "")).filter(Number.isFinite);
	const ends = p.checks.map((c) => Date.parse(c.completed ?? "")).filter(Number.isFinite);
	return {
		number: p.number,
		url: p.url,
		title: p.title,
		size: models.sizes[0] || null,
		models: models.implementers.map((i) => i.fields?.model ?? "unreadable"),
		score,
		rounds,
		hours: Math.max(0, (Date.parse(p.merged) - Date.parse(p.created)) / 3_600_000),
		ci: starts.length && ends.length ? Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 60_000) : null,
		unreadable,
	};
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rows grouped by `key`, each group's medians, largest group first. */
export function rollup(rows: Row[], key: (r: Row) => string): Rollup[] {
	const groups = new Map<string, Row[]>();
	for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
	const pick = (rs: Row[], f: (r: Row) => number | null) => median(rs.map(f).filter((v): v is number => v !== null));
	return [...groups]
		.map(([k, rs]) => ({
			key: k,
			pulls: rs.length,
			score: pick(rs, (r) => r.score),
			rounds: pick(rs, (r) => r.rounds),
			hours: pick(rs, (r) => r.hours),
			ci: pick(rs, (r) => r.ci),
		}))
		.sort((a, b) => b.pulls - a.pulls || a.key.localeCompare(b.key));
}

const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];

/** Rollups by size, in size order, and by writer. */
export function rollups(rows: Row[]): { sizes: Rollup[]; writers: Rollup[] } {
	// Sizes in ladder order, anything unsized or unknown last.
	const rank = (k: string) => (SIZE_ORDER.includes(k) ? SIZE_ORDER.indexOf(k) : SIZE_ORDER.length);
	const sizes = rollup(rows, (r) => r.size ?? "unsized").sort((a, b) => rank(a.key) - rank(b.key));
	return { sizes, writers: rollup(rows, (r) => r.models[0] ?? "unrecorded") };
}
