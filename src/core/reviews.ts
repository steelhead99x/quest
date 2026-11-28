import { parser } from "./parse";
import { TIERS, type Tier } from "./risk";

// A review post, `POST /reviews` on Kixel Quest: what one `quest review` run settled on a PR's head, and the outcomes
// of its findings as later rounds settle them. Kixel Quest imports this shape and parser, so sender and store agree.

/** A reviewing seat's role: the rung's pick, the shadow one effort away that gates nothing, or a multi-seat rung's second or third. */
export const SEATS = ["pick", "shadow", "second", "third"] as const;
export type SeatRole = (typeof SEATS)[number];

/** How severe a local reviewer judged a finding. */
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How a run left its head, as its `quest review` status attests it: every gating reviewer passed it, none ran since it
 * is low risk, the maintainer accepted the open findings, or findings are still open, which reviews nothing.
 */
export const RUN_OUTCOMES = ["passed", "passed with no local reviewer", "findings accepted", "findings open"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** How a posted finding settled: the head fixed it, the author refuted it, or it was left to later work. */
export const SETTLED = ["fixed", "refuted", "deferred"] as const;
export type Settled = (typeof SETTLED)[number];

/** One finding a round raised, its lines null where none fits. */
export interface PostedFinding {
	path: string;
	start: number | null;
	end: number | null;
	severity: Severity;
	title: string;
}

/** One reviewing seat's round on the run's head. */
export interface PostedRound {
	harness: string;
	model: string;
	effort: string;
	seat: SeatRole;
	/** The reviewing session, its harness's own ID. */
	session: string;
	/** Its place in the session, from 1. */
	round: number;
	/** How ready the head is to land, 0 to 10; null only on a round from before scores, as a backfill sends. */
	score: number | null;
	/** The score's one-sentence reason, null exactly when the score is. */
	rationale: string | null;
	findings: PostedFinding[];
}

/** The head's risk tier before and after review, and the model that classified it, null when a path or default set it. */
export interface PostedRisk {
	tier: Tier;
	reason: string;
	/** The classifier's own tier, lower when a reviewer raised it. */
	classified: Tier;
	/** The risk file's `## Automatic` class the classifier found the change in, or null. */
	class: string | null;
	classifier: { harness: string; model: string; effort: string; session: string } | null;
	/**
	 * The base's risk file the classifier read, as {@link riskFileId} names it: 12 hex characters of its blob, or `none`.
	 * Null where a run does not say, which Kixel Quest counts as it always has; the post may leave the field out.
	 */
	riskFile: string | null;
}

/** One `quest review` run on a PR's head: its classification, and each seat's round (empty only on older low-tier runs). */
export interface ReviewRun {
	repository: string;
	number: number;
	head: string;
	/** The base branch, and the merge base the run diffed the head from. */
	base: { ref: string; sha: string };
	risk: PostedRisk;
	outcome: RunOutcome;
	rounds: PostedRound[];
}

/** A posted finding's outcome, naming it by its round's session and number and its place in the round, from 1. */
export interface FindingOutcome {
	repository: string;
	number: number;
	harness: string;
	session: string;
	round: number;
	finding: number;
	outcome: Settled;
	reason: string;
}

/** What `quest review` posts at once: its runs, and the outcomes it settled. */
export interface ReviewUpload {
	runs: ReviewRun[];
	outcomes: FindingOutcome[];
}

const review = parser("review post");

const SHA = /^[0-9a-f]{40}$/;

const sha = (value: unknown, field: string): string =>
	typeof value === "string" && SHA.test(value) ? value : review.fail(`${field} is not a full lowercase SHA`);

// A round's id joins its harness, session, and number with colons, so a harness holding one would make two ids alike.
const harness = (value: unknown, field: string): string => {
	const name = review.text(value, field);
	return name.includes(":") ? review.fail(`${field} holds a colon`) : name;
};

const ordinal = (value: unknown, field: string): number =>
	Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : review.fail(field);

function postedFinding(value: unknown): PostedFinding {
	const { fail, isObject, text, oneOf, exact } = review;
	if (!isObject(value)) return fail("a finding");
	exact(value, ["path", "start", "end", "severity", "title"], "a finding");
	const start = value.start === null ? null : ordinal(value.start, "a finding's start");
	const end = value.end === null ? null : ordinal(value.end, "a finding's end");
	if ((start === null) !== (end === null) || (start !== null && end !== null && end < start))
		fail("a finding's lines are not a range");
	return {
		path: text(value.path, "a finding's path"),
		start,
		end,
		severity: oneOf(value.severity, SEVERITIES, "a finding's severity"),
		title: text(value.title, "a finding's title"),
	};
}

function postedRound(value: unknown): PostedRound {
	const { fail, isObject, text, oneOf, exact } = review;
	if (!isObject(value)) return fail("a round");
	exact(
		value,
		["harness", "model", "effort", "seat", "session", "round", "score", "rationale", "findings"],
		"a round",
	);
	const score =
		value.score === null
			? null
			: Number.isInteger(value.score) && (value.score as number) >= 0 && (value.score as number) <= 10
				? (value.score as number)
				: fail("a round's score is not 0 to 10");
	const rationale = value.rationale === null ? null : text(value.rationale, "a round's rationale");
	if ((score === null) !== (rationale === null)) fail("a round's score and rationale go together");
	if (!Array.isArray(value.findings)) return fail("a round's findings");
	return {
		harness: harness(value.harness, "a round's harness"),
		model: text(value.model, "a round's model"),
		effort: text(value.effort, "a round's effort"),
		seat: oneOf(value.seat, SEATS, "a round's seat"),
		session: text(value.session, "a round's session"),
		round: ordinal(value.round, "a round's number"),
		score,
		rationale,
		findings: value.findings.map(postedFinding),
	};
}

function postedRisk(value: unknown): PostedRisk {
	const { fail, isObject, text, maybe, oneOf, exact } = review;
	if (!isObject(value)) return fail("the risk");
	exact(value, ["tier", "reason", "classified", "class", "classifier", "riskFile"], "the risk");
	const named = value.riskFile ?? null;
	const file =
		named === null || (typeof named === "string" && /^(?:[0-9a-f]{12}|none)$/.test(named))
			? named
			: fail("the risk file is not 12 hex characters or none");
	let classifier: PostedRisk["classifier"] = null;
	if (value.classifier !== null) {
		const c = value.classifier;
		if (!isObject(c)) return fail("the classifier");
		exact(c, ["harness", "model", "effort", "session"], "the classifier");
		classifier = {
			harness: text(c.harness, "the classifier's harness"),
			model: text(c.model, "the classifier's model"),
			effort: text(c.effort, "the classifier's effort"),
			session: text(c.session, "the classifier's session"),
		};
	}
	return {
		tier: oneOf(value.tier, TIERS, "the tier"),
		reason: text(value.reason, "the risk's reason"),
		classified: oneOf(value.classified, TIERS, "the classified tier"),
		class: maybe(value.class, "the class"),
		classifier,
		riskFile: file,
	};
}

function reviewRun(value: unknown): ReviewRun {
	const { fail, isObject, text, oneOf, exact, pull, repository } = review;
	if (!isObject(value)) return fail("a run");
	exact(value, ["repository", "number", "head", "base", "risk", "outcome", "rounds"], "a run");
	const base = value.base;
	if (!isObject(base)) return fail("a run's base");
	exact(base, ["ref", "sha"], "a run's base");
	if (!Array.isArray(value.rounds)) return fail("a run's rounds");
	const run: ReviewRun = {
		repository: repository(value.repository, "a run's repository"),
		number: pull(value.number, "a run's number"),
		head: sha(value.head, "a run's head"),
		base: { ref: text(base.ref, "a run's base branch"), sha: sha(base.sha, "a run's merge base") },
		risk: postedRisk(value.risk),
		outcome: oneOf(value.outcome, RUN_OUTCOMES, "a run's outcome"),
		rounds: value.rounds.map(postedRound),
	};
	const gating = run.rounds.filter((r) => r.seat !== "shadow");
	if ((run.outcome === "passed with no local reviewer") !== (gating.length === 0))
		fail("a run passes with no local reviewer exactly when no gating seat ran");
	if (run.outcome === "passed with no local reviewer" && run.risk.tier !== "low")
		fail("only a low head passes with no local reviewer");
	if (run.outcome === "passed" && gating.some((r) => r.findings.length > 0)) fail("a run with findings did not pass");
	const rounds = new Set(run.rounds.map((r) => `${r.harness}\0${r.session}\0${r.round}`));
	if (rounds.size !== run.rounds.length) fail("a run holds a round twice");
	return run;
}

function findingOutcome(value: unknown): FindingOutcome {
	const { fail, isObject, text, oneOf, exact, pull, repository } = review;
	if (!isObject(value)) return fail("an outcome");
	exact(value, ["repository", "number", "harness", "session", "round", "finding", "outcome", "reason"], "an outcome");
	return {
		repository: repository(value.repository, "an outcome's repository"),
		number: pull(value.number, "an outcome's number"),
		harness: harness(value.harness, "an outcome's harness"),
		session: text(value.session, "an outcome's session"),
		round: ordinal(value.round, "an outcome's round"),
		finding: ordinal(value.finding, "an outcome's finding"),
		outcome: oneOf(value.outcome, SETTLED, "an outcome"),
		reason: text(value.reason, "an outcome's reason"),
	};
}

/** A review post's body, failing whole on any malformed run or outcome, or a round or outcome sent twice. */
export function parseReviews(value: unknown): ReviewUpload {
	const { fail, isObject, exact } = review;
	if (!isObject(value)) return fail("the post is not an object");
	exact(value, ["runs", "outcomes"], "the post");
	if (!Array.isArray(value.runs)) return fail("the post has no run list");
	if (!Array.isArray(value.outcomes)) return fail("the post has no outcome list");
	const runs = value.runs.map(reviewRun);
	const outcomes = value.outcomes.map(findingOutcome);
	const rounds = runs.flatMap((run) =>
		run.rounds.map((r) => `${run.repository}\0${run.number}\0${r.harness}\0${r.session}\0${r.round}`),
	);
	if (new Set(rounds).size !== rounds.length) fail("the post holds a round twice");
	const settled = outcomes.map(
		(o) => `${o.repository}\0${o.number}\0${o.harness}\0${o.session}\0${o.round}\0${o.finding}`,
	);
	if (new Set(settled).size !== settled.length) fail("the post settles a finding twice");
	return { runs, outcomes };
}
