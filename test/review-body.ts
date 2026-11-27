// The PR body's `## Review` record as `quest review` wrote it before it posted rounds to Kixel Quest, which `quest usage`
// still reads from merged PRs' bodies; tests build those bodies with it.
import { PATHS, REVIEW_MARK, codeSpan, riskFileId } from "../src/core";
import { type Reviewed, type Risk, SEVERITIES, type Tally, located, sameSeat } from "../src/cli/review";
import { type Counts, HARNESSES, findingsText, passed } from "../src/cli/review-record";

/**
 * Model text as one inline code span, so a mention, issue reference, or Markdown in it renders as text.
 * `quest status` takes the last full SHA the section names as its reviewed head, so no full SHA appears in it.
 */
function code(text: string): string {
	return codeSpan(
		text
			.replace(/\s+/g, " ")
			.trim()
			.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 12)),
	);
}

const capitalized = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/**
 * A block's Reviewer line, ending in `, second` for the
 * second reviewer a high-risk head gets.
 */
const reviewerLine = (seat: Pick<Tally, "reviewer" | "model" | "effort" | "second">) =>
	`- Reviewer: ${HARNESSES[seat.reviewer]}, ${seat.model}, ${seat.effort} effort${seat.second ? ", second" : ""}`;

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
	return `${HARNESSES[by.harness]}, ${by.model}, ${by.effort} effort, session ${code(by.session)}`;
}

/**
 * The `## Review` section's text for a run's `rounds` of the same head, without its heading: the head's risk and each
 * reviewer the run skipped since it could not run, then every tally on the branch, each round's reviewer's beside its
 * round, and a reviewer the run left out on its own.
 */
export function reviewRecord({
	rounds,
	tallies,
	risk,
	skipped,
	head,
	base,
	accepted,
}: Pick<Reviewed, "rounds" | "tallies" | "risk" | "skipped" | "head" | "base" | "accepted">): string {
	const clean = passed({ rounds, tallies, accepted });
	const lines = [
		REVIEW_MARK,
		"",
		// `quest status` counts a full SHA here as a review of that head, which an open finding has not passed.
		`- Head: ${clean ? head : `${head.slice(0, 12)}, named in full once no reviewer reports a finding`}`,
		`- Base: ${base.ref} at ${base.sha.slice(0, 12)}`,
		`- Risk: ${risk.tier}, ${code(risk.reason)}`,
		...(risk.overridden ? [`- Overridden: from ${risk.overridden} by the maintainer`] : []),
		`- Classified: ${risk.classified.tier} by ${classifiedBy(risk.classified)}`,
		...(risk.classified.class === null ? [] : [`- Class: \`${risk.classified.class}\``]),
		// By 12 characters, since `quest status` reads the section's last full SHA as the reviewed head.
		`- Risk file: ${riskFileId(risk.classified.riskFile)}`,
		...(rounds.length === 0 ? [`- Local review: none, since the head is low risk`] : []),
		...(accepted === undefined ? [] : [`- Accepted by the maintainer: ${code(accepted)}`]),
		// Outside the Reviewer blocks, which `parseReview` reads as reviewers that ran.
		...skipped.map(
			(skip) => `- Skipped: ${HARNESSES[skip.harness]}, ${skip.model}, ${skip.effort} effort: ${skip.reason}`,
		),
	];
	for (const round of rounds) {
		lines.push(
			"",
			reviewerLine(round),
			`- Session: ${code(round.session)}, round ${round.round}`,
			`- Score: ${round.score}/10, ${code(round.rationale)}`,
			...(round.recommendation === null ? [] : [`- Recommendation: ${code(round.recommendation)}`]),
		);
		const tally = tallies.find((each) => sameSeat(each, round));
		if (tally === undefined) throw new Error(`no tally for ${round.reviewer}'s round`);
		lines.push(`- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`);
		if (round.findings.length === 0) lines.push("- Findings: none");
		else
			lines.push(
				accepted === undefined
					? "- Findings, open until the next round settles them:"
					: "- Findings, accepted by the maintainer:",
			);
		for (const finding of round.findings)
			lines.push(`  - ${capitalized(finding.severity)}, ${code(located(finding))}: ${code(finding.title)}`);
		if (round.notes.length > 0) lines.push("- Notes, the author's to take or leave:");
		for (const note of round.notes) lines.push(`  - ${code(located(note))}: ${code(note.title)}`);
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
			`- Rounds: ${tally.rounds}; ${findingsText(counted(tally))}`,
		);
	return lines.join("\n");
}
