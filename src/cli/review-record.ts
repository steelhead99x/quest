// `quest review` rewrites the `## Review` section of its branch's open PR after each round, so the head
// it reviewed counts without an agent copying the round into the body by hand.
import { type Counts, DEFAULT, PATHS, REVIEW_MARK, codeSpan, reviewSection, riskFileId } from "../core";

// The record's reader lives in core, which the quest log Worker shares; callers keep importing it here.
export { type Counts, type ReviewSummary, parseReview } from "../core";
import { recorded } from "./models-record";
import { type ClaimDependencies, upstream } from "./claims";
import { pullsFrom } from "../github/claims";
import { object, repositoryPath } from "../github/client";
import { REVIEW_CONTEXT, attestation, reviewTarget } from "../github/review-trust";
import { git } from "./git";
import { contains } from "./land";
import { requireRemote } from "./github";
import {
	type PullModels,
	type Reviewed,
	type Risk,
	type Round,
	SEVERITIES,
	type Tally,
	located,
	parseBase,
	sameSeat,
} from "./review";

/** The name a PR body's review record gives each reviewer's CLI. */
export const HARNESSES: Record<Round["reviewer"], string> = {
	claude: "Claude Code",
	codex: "Codex",
};

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
 * The `## Review` section's text for a run's `rounds` of the same head, without its heading: the head's risk and each
 * reviewer the run skipped since it could not run, then every tally on the branch, each round's reviewer's beside its
 * round, and a reviewer the run left out on its own.
 */
export function reviewRecord({ rounds, tallies, risk, skipped, head, base, accepted }: Reviewed): string {
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

/**
 * The reviewer sessions `body`'s `## Review` record names, read from its `Session:` lines alone, so a record whose
 * other lines this version cannot parse, as one a newer `quest review` wrote, still names them.
 */
export function reviewSessions(body: string): string[] {
	const section = reviewSection(body);
	if (!section) return [];
	const all = body.slice(section.start, section.end);
	const at = all.indexOf(REVIEW_MARK);
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

/** Whether a run passed its head: no finding open, including a reviewer's the run left out, or the maintainer accepted them. */
const passed = ({ rounds, tallies, accepted }: Pick<Reviewed, "rounds" | "tallies" | "accepted">) =>
	accepted !== undefined ||
	(rounds.every((round) => round.findings.length === 0) && tallies.every((tally) => counted(tally).open === 0));

/**
 * Where a round's record went: the PR whose body holds it, and why its status was not set, skipped for a token that
 * cannot push, whose status would count for nothing, else refused; or why no body changed.
 */
export type Recorded = { url: string; status?: Unattested } | { skipped: string };

/** Why `quest review` set no status on the head it recorded. */
type Unattested = { skipped: string } | { refused: string };

/**
 * The open PR from `branch` into the base `<remote>/<branch>` names, or why there is none: the one from the repository
 * the base's remote pushes to, else the only one from any repository whose head `HEAD` contains, as a maintainer's
 * checkout of a contributor's fork PR finds it. The list comes from the forge, and on GitHub the body from the PR itself.
 */
async function openPull(
	root: string,
	baseRef: string,
	branch: string,
	deps: ClaimDependencies,
): Promise<
	| {
			url: string;
			body: string;
			edit(body: string): Promise<void>;
			/** Set the `quest review` status on `head`, for its diff from the merge base `from`, or say why not. */
			attest(status: {
				head: string;
				from: string;
				state: "success" | "failure";
				description: string;
			}): Promise<Unattested | null>;
	  }
	| { skipped: string }
> {
	// The checkout's top level: a subdirectory would look for the quest tree below it.
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const { remote, branch: base } = parseBase(top, baseRef);
	const up = await upstream(top, requireRemote(top, remote), deps);
	const hosting = up.hosting;
	if (hosting === null) return { skipped: `${remote} is not on GitHub or Kixel Quest` };
	const { repository, head } = hosting;
	const name = `${head.owner}/${head.repo}`.toLowerCase();
	const candidates = pullsFrom((await (await hosting.forge()).pulls(repository)).value, branch).filter(
		(each) => each.base === base,
	);
	const own = candidates.find((each) => each.head?.toLowerCase() === name);
	// Another repository's PR counts only when this checkout holds its pushed head, so a stranger's PR from a
	// branch of the same name neither sets the round's size nor receives its record.
	const held = candidates.filter((each) => each.sha !== undefined && contains(top, each.sha, "HEAD"));
	const pull = own ?? (held.length === 1 ? held[0] : undefined);
	if (pull === undefined)
		return {
			skipped:
				candidates.length === 0
					? `no open PR from ${branch} into ${base}`
					: held.length === 0
						? `no open PR from ${branch} into ${base} from ${head.owner} or with a head this checkout holds: ${candidates.map((each) => each.url).join(", ")}`
						: `several open PRs from ${branch} into ${base} with heads this checkout holds, none from ${head.owner}: ${held.map((each) => each.url).join(", ")}`,
		};
	// The forge's list may predate an edit just made, such as the `## Models` record written before a round, and the
	// record rewrites the whole body, so on GitHub the body comes fresh from the PR itself, on the person's token.
	const body =
		up.github === null
			? pull.body
			: ((object(
					await (await up.github.client.request(`${repositoryPath(repository)}/pulls/${pull.number}`)).json(),
				).body as string | null) ?? "");
	return {
		url: pull.url,
		body,
		edit: (body) => hosting.writes().edit({ ...repository, number: pull.number }, { title: null, body }),
		// The status goes on the person's own token, which `quest status` counts only when it can push. Another forge
		// has no commit statuses here, and decides on its own which record counts.
		attest: async ({ head: sha, from, state, description }) => {
			if (up.github === null) return null;
			const { client } = up.github;
			const response = await client.request(`${repositoryPath(repository)}/statuses/${sha}`, {
				body: { state, context: REVIEW_CONTEXT, description, target_url: reviewTarget(repository, from, sha) },
				allow: [403, 404, 422],
				// The latest status per context wins, so setting it again leaves the same state.
				repeat: true,
			});
			if (response.ok) return null;
			const message = String(object(await response.json()).message);
			if (response.status === 422)
				return { refused: `GitHub refused the status on ${sha}: ${message}; push it, then review it again` };
			const name = `${repository.owner}/${repository.repo}`;
			const permissions = object(await (await client.request(repositoryPath(repository))).json()).permissions;
			return permissions != null && object(permissions).push === true
				? {
						refused: `GitHub refused the status (HTTP ${response.status}: ${message}); the token needs write access to ${name}'s commit statuses`,
					}
				: { skipped: `you cannot push to ${name}, so only a maintainer's round counts` };
		},
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

/**
 * Attest a run with a `quest review` status on its head, which `quest status` counts only when the token's user can
 * push, and record it in the `## Review` section of its branch's open PR.
 */
export async function recordRounds(root: string, reviewed: Reviewed, deps: ClaimDependencies): Promise<Recorded> {
	const pull = await openPull(root, reviewed.base.ref, reviewed.branch, deps);
	if ("skipped" in pull) return pull;
	const next = withReview(pull.body, reviewRecord(reviewed));
	const ok = passed(reviewed);
	const outcome = !ok
		? "findings open"
		: reviewed.accepted !== undefined
			? "findings accepted"
			: reviewed.rounds.length === 0
				? "passed with no local reviewer"
				: "passed";
	let status: Awaited<ReturnType<typeof pull.attest>>;
	try {
		status = await pull.attest({
			head: reviewed.head,
			from: git(root, ["merge-base", reviewed.base.sha, reviewed.head]),
			state: ok ? "success" : "failure",
			description: attestation(
				{
					tier: reviewed.risk.tier,
					class: reviewed.risk.classified.class,
					riskFile: riskFileId(reviewed.risk.classified.riskFile),
				},
				outcome,
			),
		});
	} catch (error) {
		// A record of open findings names no full SHA, so writing it still ends any earlier pass of this head.
		if (!ok && next !== pull.body) await pull.edit(next);
		throw error;
	}
	// The status goes first, so a body edit that fails cannot leave an earlier pass standing for a failed head; an
	// acceptance no status records is written nowhere.
	if (next !== pull.body && !(status !== null && reviewed.accepted !== undefined)) await pull.edit(next);
	return status === null ? { url: pull.url } : { url: pull.url, status };
}
