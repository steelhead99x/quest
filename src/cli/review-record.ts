// `quest review` rewrites the `## Review` section of its branch's open PR after each round, so the head
// it reviewed counts without an agent copying the round into the body by hand.
import { type Counts, DEFAULT, PATHS, REVIEW_MARK, reviewSection, SEVERITIES } from "../core";
import { recorded } from "./models-record";
import { type ClaimDependencies, upstream } from "./claims";
import { repositoryPath } from "../github/client";
import { git } from "./git";
import { requireRemote } from "./github";
import { string } from "../github/client";
import {
	type PullModels,
	type Reviewed,
	type Risk,
	type Round,
	type Tally,
	located,
	parseBase,
	sameSeat,
} from "./review";

// The record's reader lives in core, which the Worker shares; callers keep importing it here.
export { type Counts, type ReviewSummary, parseReview } from "../core";

const HARNESSES: Record<Round["reviewer"], string> = { claude: "Claude Code", codex: "Codex" };

/**
 * Model text as one inline code span, so a mention, issue reference, or Markdown in it renders as text.
 * `quest status` takes the last full SHA the section names as its reviewed head, so no full SHA appears in it.
 */
function code(text: string): string {
	const flat = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 12));
	const fence = "`".repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	const pad = /^`|`$/.test(flat) ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

const capitalized = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** A block's Reviewer line, ending in `, shadow` for the shadow, the size's pick one effort lower. */
const reviewerLine = (seat: Pick<Tally, "reviewer" | "model" | "effort" | "shadow">) =>
	`- Reviewer: ${HARNESSES[seat.reviewer]}, ${seat.model}, ${seat.effort} effort${seat.shadow ? ", shadow" : ""}`;

/** Findings as their total, then each severity found, such as `3 (high 1, low 2)`. */
export function severityText(findings: Tally["findings"]): string {
	const total = SEVERITIES.reduce((sum, severity) => sum + findings[severity], 0);
	const severities = SEVERITIES.filter((severity) => findings[severity] > 0)
		.map((severity) => `${severity} ${findings[severity]}`)
		.join(", ");
	return `${total}${severities && ` (${severities})`}`;
}

/** The counts as the record's `Rounds:` line ends, after the rounds. */
export function findingsText(counts: Omit<Counts, "rounds">): string {
	return `${counts.first === null ? "" : `first round ${severityText(counts.first)}; `}findings ${severityText(counts.findings)}: fixed ${counts.fixed}, refuted ${counts.refuted}${counts.settled > 0 ? `, settled ${counts.settled}` : ""}, open ${counts.open}`;
}

/** A tally's counts, where a finding neither fixed nor refuted is open. */
const counted = ({ first, ...tally }: Tally): Counts => ({
	...tally,
	first: first ?? null,
	settled: 0,
	open: SEVERITIES.reduce((sum, severity) => sum + tally.findings[severity], 0) - tally.fixed - tally.refuted,
});

/** How the record names what set the classifier's tier, as `recordedRisk` reads it back. */
function classifiedBy({ by }: Risk["classified"]): string {
	if (by.kind === "paths") return PATHS;
	if (by.kind === "default") return DEFAULT;
	return `${HARNESSES[by.harness]}, ${by.model}, ${by.effort} effort, session ${code(by.session)}`;
}

/**
 * The `## Review` section's text for a run's `rounds` of the same head, without its heading: the head's risk, then
 * every tally on the branch, each round's reviewer's beside its round, and a reviewer the run left out on its own.
 */
export function reviewRecord({ rounds, tallies, risk }: Reviewed): string {
	const [shared] = rounds;
	// A reviewer the run left out may still hold open findings, which keep the head from passing too.
	const clean =
		rounds.every((round) => round.findings.length === 0) && tallies.every((tally) => counted(tally).open === 0);
	const lines = [
		MARK,
		"",
		// `quest status` counts a full SHA here as a review of that head, which an open finding has not passed.
		`- Head: ${clean ? shared!.head : `${shared!.head.slice(0, 12)}, named in full once no reviewer reports a finding`}`,
		`- Base: ${shared!.base.ref} at ${shared!.base.sha.slice(0, 12)}`,
		`- Risk: ${risk.tier}, ${code(risk.reason)}`,
		`- Classified: ${risk.classified.tier} by ${classifiedBy(risk.classified)}`,
	];
	for (const round of rounds) {
		lines.push(
			"",
			reviewerLine(round),
			`- Session: ${code(round.session)}, round ${round.round}`,
			`- Score: ${round.score}/10, ${code(round.rationale)}`,
			...(round.raised ? [`- Raised the risk to ${round.raised.tier}: ${code(round.raised.reason)}`] : []),
		);
		const tally = tallies.find((each) => sameSeat(each, round));
		if (tally === undefined) throw new Error(`no tally for ${round.reviewer}'s round`);
		lines.push(`- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`);
		if (round.findings.length === 0) lines.push("- Findings: none");
		else lines.push("- Findings, open until the next round settles them:");
		for (const finding of round.findings)
			lines.push(`  - ${capitalized(finding.severity)}, ${code(located(finding))}: ${code(finding.title)}`);
		const settled = round.earlier?.findings ?? [];
		if (settled.length > 0) lines.push(`- The last round's findings, at ${round.earlier!.head.slice(0, 12)}:`);
		for (const finding of settled)
			lines.push(
				`  - ${capitalized(finding.disposition)}: ${finding.severity}, ${code(located(finding))}: ${code(finding.title)}; ${code(finding.reason)}`,
			);
	}
	for (const tally of tallies.filter((each) => !rounds.some((round) => sameSeat(round, each))))
		lines.push(
			"",
			reviewerLine(tally),
			// Its session, still named so `quest usage` counts it as reviewing.
			...(tally.session === undefined ? [] : [`- Session: ${code(tally.session)}`]),
			// Its last round reviewed this head, so its raise still holds.
			...(risk.raisedBy && sameSeat(risk.raisedBy, tally)
				? [`- Raised the risk to ${risk.tier}: ${code(risk.reason)}`]
				: []),
			`- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`,
		);
	return lines.join("\n");
}

const MARK = REVIEW_MARK;

/**
 * The reviewer sessions `body`'s `## Review` record names, read from its `Session:` lines alone, so a record whose
 * other lines this version cannot parse, as one a newer `quest review` wrote, still names them.
 */
export function reviewSessions(body: string): string[] {
	const section = reviewSection(body);
	if (!section) return [];
	const all = body.slice(section.start, section.end);
	const at = all.indexOf(MARK);
	if (at < 0) return [];
	return [...all.slice(at).matchAll(/^- Session: (`+) ?(.*?) ?\1(?:, round \d+)?\r?$/gm)].map((found) => found[2]!);
}

/**
 * The risk classifier session `body`'s `## Review` record names, read from its `Classified:` line alone, as
 * `reviewSessions` reads reviewers.
 */
export function classifierSessions(body: string): string[] {
	const section = reviewSection(body);
	if (!section) return [];
	const found = /^- Classified: \S+ by .*, session (`+) ?(.*?) ?\1\r?$/m.exec(body.slice(section.start, section.end));
	return found ? [found[2]!] : [];
}

/** `body` with `record` as its `## Review` section, which it gains when it has none; the rest stays as written. */
export function withReview(body: string, record: string): string {
	const section = reviewSection(body);
	if (!section) {
		const appended = `${body.trimEnd()}${body.trim() ? "\n\n" : ""}## Review\n\n${record}\n`;
		// A body that ends inside an unclosed code fence or HTML comment would swallow the heading.
		if (reviewSection(appended) === null)
			throw new Error(
				"the PR body ends inside an unclosed code fence or HTML comment; close it so the record can follow",
			);
		return appended;
	}
	const { start, end } = section;
	return `${body.slice(0, start)}\n\n${record}\n${end < body.length ? "\n" : ""}${body.slice(end)}`;
}

/** Where a round's record went: the PR whose body holds it, or why no body changed. */
export type Recorded = { url: string } | { skipped: string };

/**
 * The open PR from `branch` into the base `<remote>/<branch>` names, found among the upstream's PRs from the
 * repository the base's remote pushes to, as claims find a branch's PR; or why there is none.
 */
async function openPull(root: string, baseRef: string, branch: string, deps: ClaimDependencies) {
	// The checkout's top level: a subdirectory would look for the quest tree below it.
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const { remote, branch: base } = parseBase(top, baseRef);
	const up = await upstream(top, requireRemote(top, remote), deps);
	if (up.github === null) return { skipped: `${remote} is not on GitHub` };
	const { client, repository, head } = up.github;
	const from = `${head.owner}:${branch}`;
	const query = `state=open&head=${encodeURIComponent(from)}&base=${encodeURIComponent(base)}&per_page=100`;
	const [pull] = await client.all(`${repositoryPath(repository)}/pulls?${query}`);
	if (pull === undefined) return { skipped: `no open PR from ${from} into ${base}` };
	const path = `${repositoryPath(repository)}/pulls/${Number(pull.number)}`;
	return {
		client,
		path,
		number: Number(pull.number),
		repository,
		url: string(pull.html_url),
		body: typeof pull.body === "string" ? pull.body : "",
	};
}

/** The `## Models` record of `branch`'s open PR into `baseRef`, or null when it has no PR. */
export async function pullModels(
	root: string,
	baseRef: string,
	branch: string,
	deps: ClaimDependencies,
): Promise<PullModels | null> {
	const pull = await openPull(root, baseRef, branch, deps);
	if ("skipped" in pull) return null;
	return recorded(pull.body);
}

/** Record a run in the `## Review` section of its branch's open PR. The edit is the token's user's, which `/quest-merge` counts only when that user wrote the PR. */
export async function recordRounds(root: string, reviewed: Reviewed, deps: ClaimDependencies): Promise<Recorded> {
	const [shared] = reviewed.rounds;
	const pull = await openPull(root, shared!.base.ref, shared!.branch, deps);
	if ("skipped" in pull) return pull;
	const next = withReview(pull.body, reviewRecord(reviewed));
	if (next !== pull.body) await pull.client.request(pull.path, { method: "PATCH", body: { body: next } });
	return { url: pull.url };
}
