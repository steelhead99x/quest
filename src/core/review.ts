// A PR body's `## Review` record, which `quest review` writes and `quest status` reads.

import { markdown } from "./doc";

/** The line that opens the record `quest review` writes, which only its rounds keep. */
export const REVIEW_MARK = "Rewritten by `quest review` after each round.";

/**
 * Where the body of the first `## Review` section runs: from after its heading's line to the next level-1
 * or level-2 heading's line, or the end. Only top-level headings count, as Markdown parses them, so an
 * example inside a code fence, a list, or a quote is text. Null without one.
 */
export function reviewSection(body: string): { start: number; end: number } | null {
	const lineStart = (offset: number) => body.lastIndexOf("\n", offset - 1) + 1;
	let start: number | undefined;
	for (const node of markdown(body).children) {
		if (node.type !== "heading" || node.depth > 2) continue;
		const from = node.position!.start.offset!;
		if (start !== undefined) return { start, end: lineStart(from) };
		const to = node.position!.end.offset!;
		if (node.depth === 2 && /^##[ \t]+Review[ \t]*$/.test(body.slice(lineStart(from), to)))
			start = body[to] === "\r" ? to + 1 : to;
	}
	return start === undefined ? null : { start, end: body.length };
}

// The `## Review` record's reader, pure so the quest log Worker (cloudflare/) can share it; `quest review`'s
// writer and the rest of the record live in src/cli/review-record.ts, which re-exports these.

/** Each finding's severity, highest first. */
export const SEVERITIES = ["high", "medium", "low"] as const;

/** A count of findings per severity. */
export type Findings = Record<(typeof SEVERITIES)[number], number>;

/** A tally's counts, as the record's `Rounds:` line and `quest usage` write them. */
export interface Counts {
	rounds: number;
	/** The first round's findings, null when the tally began before rounds kept them. */
	first: Findings | null;
	findings: Findings;
	fixed: number;
	refuted: number;
	/** Findings the maintainer accepted, or open ones of a merged PR's last all-low round, which the review rule once settled before merge. */
	settled: number;
	open: number;
}

/** What a PR body's `## Review` record says of one reviewer, as `reviewRecord` writes it. */
export interface ReviewSummary {
	/** The reviewer's harness as the record names it, such as `Codex`. */
	harness: string;
	model: string;
	effort: string;
	/** Whether it is the shadow: the size's pick one effort away, beside it on the same heads. */
	shadow: boolean;
	/** Whether it is the second reviewer a high-risk head gets, from a vendor other than the pick's. */
	second: boolean;
	/** Its latest session, null when the record names none; its round, null when the latest run left it out. */
	session: string | null;
	round: number | null;
	/** Null when the latest run left it out, or on a record written before rounds were scored. */
	score: number | null;
	/** Its findings across every round on the branch, null on a record written before tallies. */
	tally: Counts | null;
	/** The severity of each finding its latest round left open. */
	open: Findings;
}

/**
 * Each reviewer's latest round `body`'s `## Review` section records, or none when `quest review` wrote none
 * there, as for a low head's record or a section with only the land fixer's fixes.
 */
export function parseReview(body: string): ReviewSummary[] {
	const section = reviewSection(body);
	if (!section) return [];
	const all = body.slice(section.start, section.end);
	const at = all.indexOf(REVIEW_MARK);
	if (at < 0) return [];
	// Findings the maintainer accepted are settled, not open.
	const accepted = /^- Accepted by the maintainer: /m.test(all);
	// Each reviewer's block starts at its Reviewer line.
	const blocks = all
		.slice(at)
		.split(/^(?=- Reviewer: )/m)
		.slice(1);
	return blocks.map((text) => {
		const match = (pattern: RegExp) => {
			const found = pattern.exec(text);
			if (!found) throw new Error(`the ## Review record has no line matching ${pattern.source}`);
			return found;
		};
		const reviewer = match(/^- Reviewer: (.+?), (\S+), (\S+) effort(?:(, shadow)|(, second))?\r?$/m);
		const counts = parseCounts(text);
		const tally =
			accepted && counts !== null ? { ...counts, settled: counts.settled + counts.open, open: 0 } : counts;
		// A reviewer the latest run left out has its tally, and its session with no round once tallies name it.
		const session =
			tally !== null && !/^- Session: /m.test(text)
				? null
				: match(
						tally === null
							? /^- Session: (`+) ?(.*?) ?\1, round (\d+)\r?$/m
							: /^- Session: (`+) ?(.*?) ?\1(?:, round (\d+))?\r?$/m,
					);
		const score = /^- Score: (\d+)\/10,/m.exec(text);
		const open = { high: 0, medium: 0, low: 0 };
		if (!accepted)
			for (const [, severity] of text.matchAll(/^  - (High|Medium|Low), /gm))
				open[severity!.toLowerCase() as keyof typeof open]++;
		return {
			harness: reviewer[1]!,
			model: reviewer[2]!,
			effort: reviewer[3]!,
			shadow: reviewer[4] !== undefined,
			second: reviewer[5] !== undefined,
			session: session && session[2]!,
			round: session?.[3] === undefined ? null : Number(session[3]),
			score: score ? Number(score[1]) : null,
			tally,
			open,
		};
	});
}

/** A block's `Rounds:` line, or null without one; malformed or inconsistent counts fail. */
function parseCounts(text: string): Counts | null {
	const line = /^- Rounds: (.*?)\r?$/m.exec(text);
	if (!line) return null;
	const found =
		/^(\d+); (?:first round (\d+)(?: \(([^)]*)\))?; )?findings (\d+)(?: \(([^)]*)\))?: fixed (\d+), refuted (\d+)(?:, settled (\d+))?, open (\d+)$/.exec(
			line[1]!,
		);
	const malformed = () => new Error(`the ## Review record's Rounds line is malformed: ${line[1]}`);
	if (!found) throw malformed();
	// Each severity's count, checked against the total the line states.
	const severities = (total: string, list: string | undefined) => {
		const findings = { high: 0, medium: 0, low: 0 };
		for (const part of list?.split(", ") ?? []) {
			const [severity, count] = part.split(" ");
			if (!SEVERITIES.includes(severity as keyof typeof findings) || !/^\d+$/.test(count ?? ""))
				throw malformed();
			findings[severity as keyof typeof findings] = Number(count);
		}
		if (SEVERITIES.reduce((sum, severity) => sum + findings[severity], 0) !== Number(total))
			throw new Error(`the ## Review record's Rounds line does not add up: ${line[1]}`);
		return findings;
	};
	const findings = severities(found[4]!, found[5]);
	const counts = {
		rounds: Number(found[1]),
		first: found[2] === undefined ? null : severities(found[2], found[3]),
		findings,
		fixed: Number(found[6]),
		refuted: Number(found[7]),
		settled: Number(found[8] ?? 0),
		open: Number(found[9]),
	};
	if (counts.fixed + counts.refuted + counts.settled + counts.open !== Number(found[4]))
		throw new Error(`the ## Review record's Rounds line does not add up: ${line[1]}`);
	return counts;
}
