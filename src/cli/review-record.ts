// `quest review` posts each run to Kixel Quest and attests it with a `quest review` commit status on GitHub, on its
// branch's open PR. The readers below parse the PR body's `## Review` record earlier versions wrote, which `quest usage`
// still reads from merged PRs.
import {
	REVIEW_MARK,
	type ReviewRun,
	type ReviewUpload,
	type RunOutcome,
	parseReviews,
	reviewSection,
	riskFileId,
	type Counts,
} from "../core";

// The PR-body record's reader lives in core, which the quest log Worker shares; callers keep importing it here.
export { type Counts, type ReviewSummary, parseReview } from "../core";
import { recorded } from "./models-record";
import { type ClaimDependencies, same, upstream } from "./claims";
import { pullsFrom } from "../github/claims";
import { object, repositoryPath } from "../github/client";
import { REVIEW_CONTEXT, attestation, reviewTarget } from "../github/review-trust";
import { git } from "./git";
import { contains } from "./land";
import { remoteRepository, requireRemote } from "./github";
import { type ForgeDependencies, KixelQuest } from "./forge";
import { kixelUrl, requireToken } from "./tokens";
import { type PullModels, type Reviewed, type Round, SEVERITIES, type Tally, parseBase } from "./review";

/** The name a PR body's review record gives each reviewer's CLI. */
export const HARNESSES: Record<Round["reviewer"], string> = {
	claude: "Claude Code",
	codex: "Codex",
};

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

/** Whether a run passed its head: no finding open, including a reviewer's the run left out, or the maintainer accepted them. */
export const passed = ({ rounds, tallies, accepted }: Pick<Reviewed, "rounds" | "tallies" | "accepted">) =>
	accepted !== undefined ||
	(rounds.every((round) => round.findings.length === 0) && tallies.every((tally) => counted(tally).open === 0));

/**
 * Where a run's record went: the PR it was posted for, and why its status was not set, skipped for a token that cannot
 * push, whose status would count for nothing, else refused; or why nothing was posted.
 */
export type Recorded =
	| {
			url: string;
			status?: Unattested;
			/** Why nothing was posted, and the PR the run would have been posted on, as Kixel Quest names it. */
			post?: { skipped: string; at: { repository: string; number: number } };
	  }
	| { skipped: string };

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
			/** The base repository as lowercase `owner/repo`, and the PR's number, as Kixel Quest names it. */
			repository: string;
			number: number;
			/** The PR's base branch. */
			base: string;
			/** Whether Kixel Quest hosts the repository, rather than GitHub. */
			hosted: boolean;
			/** Whether the PR is the head fork's own, found there when its upstream has none. */
			fork: boolean;
			/** The PR's body as it is now. */
			body(): Promise<string>;
			/** The merge base GitHub finds for `head` with the PR's base, as the land gate binds the status to; null when it cannot compare them. */
			mergeBase(head: string): Promise<string | null>;
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
	const { head } = hosting;
	let repository = hosting.repository;
	const name = `${head.owner}/${head.repo}`.toLowerCase();
	const candidates = pullsFrom((await (await hosting.forge()).pulls(repository)).value, branch).filter(
		(each) => each.base === base,
	);
	const own = candidates.find((each) => each.head?.toLowerCase() === name);
	// Another repository's PR counts only when this checkout holds its pushed head, so a stranger's PR from a
	// branch of the same name neither sets the round's size nor receives its record.
	const held = candidates.filter((each) => each.sha !== undefined && contains(top, each.sha, "HEAD"));
	let pull = own ?? (held.length === 1 ? held[0] : undefined);
	// A fork that works on itself opens its PRs there, never upstream: with none upstream, the head repository's own
	// PR from the branch into the same base takes the record, as `quest merge` on that fork reads it.
	let fork = false;
	const github = up.github;
	// The base must be the fork's own branch, which the remote fetches only when it fetches from the fork itself.
	const fetched = remoteRepository(requireRemote(top, remote)).repository;
	const fetchesHead = fetched !== null && same(fetched, head);
	if (pull === undefined && held.length === 0 && github !== null && !same(head, repository) && fetchesHead) {
		pull = pullsFrom((await (await deps.forge(head)).pulls(head)).value, branch).find(
			(each) => each.base === base && each.head?.toLowerCase() === name,
		);
		if (pull !== undefined) {
			repository = head;
			fork = true;
		}
	}
	if (pull === undefined)
		return {
			skipped:
				candidates.length === 0
					? `no open PR from ${branch} into ${base}${
							github === null || same(head, repository)
								? ""
								: fetchesHead
									? ` in ${repository.owner}/${repository.repo} or ${head.owner}/${head.repo}`
									: ` in ${repository.owner}/${repository.repo}; for a PR into ${head.owner}/${head.repo}, pass a base on a remote that fetches from it`
						}`
					: held.length === 0
						? `no open PR from ${branch} into ${base} from ${head.owner} or with a head this checkout holds: ${candidates.map((each) => each.url).join(", ")}`
						: `several open PRs from ${branch} into ${base} with heads this checkout holds, none from ${head.owner}: ${held.map((each) => each.url).join(", ")}`,
		};
	return {
		url: pull.url,
		repository: `${repository.owner}/${repository.repo}`.toLowerCase(),
		number: pull.number,
		base,
		hosted: github === null,
		fork,
		// The forge's list may predate an edit just made, such as the `## Models` record written before a round, so on
		// GitHub the body comes fresh from the PR itself, on the person's token.
		body: async () =>
			github === null
				? pull.body
				: ((object(
						await (
							await github.client.request(`${repositoryPath(repository)}/pulls/${pull.number}`)
						).json(),
					).body as string | null) ?? ""),
		mergeBase: async (sha) => {
			if (github === null) return null;
			const response = await github.client.request(
				`${repositoryPath(repository)}/compare/${encodeURIComponent(base)}...${sha}?per_page=1`,
				{ allow: [404, 422] },
			);
			if (!response.ok) return null;
			return String(object(object(await response.json()).merge_base_commit).sha);
		},
		// The status goes on the person's own token, which the land gate counts only when it can push. Another forge
		// has no commit statuses here, and counts only a writer's post.
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
	return recorded(await pull.body());
}

/**
 * Fail unless this host can post a run on `branch`'s open PR into `baseRef` before any reviewer spends a round: it must
 * be signed in to Kixel Quest, and Kixel Quest must serve the PR's repository, since it stores no post for one it does
 * not. A branch with no such PR posts nothing, so it needs only the sign-in.
 */
export async function requirePosting(
	root: string,
	baseRef: string,
	branch: string,
	deps: ClaimDependencies & Omit<ForgeDependencies, "warn">,
): Promise<void> {
	const url = kixelUrl(deps.env);
	const token = requireToken(url, deps.env);
	const pull = await openPull(root, baseRef, branch, deps);
	// A repository Kixel Quest hosts is one it serves, and a fork's own PR it does not serve records its status alone.
	if ("skipped" in pull || pull.hosted || pull.fork) return;
	const [owner, repo] = pull.repository.split("/") as [string, string];
	if (!(await new KixelQuest(url, token, deps, false).serves({ owner, repo })))
		throw new Error(
			`${url} does not serve ${pull.repository}, so it would store no review of it; install its GitHub App on the repository first`,
		);
}

/**
 * Attest a run with a `quest review` status on its head, which the land gate counts only when the token's user can push,
 * and post it to Kixel Quest for its branch's open PR, which counts it only when its poster can push. Either failing
 * fails the run. The status goes first as a failure, which a passing run turns to success only once the post is stored,
 * so a post that fails leaves the head failing, never an earlier pass or a pending status the land gate would pass over.
 */
export async function recordRounds(
	root: string,
	reviewed: Reviewed,
	deps: ClaimDependencies & Omit<ForgeDependencies, "warn">,
): Promise<Recorded> {
	// Checked first, so a host that cannot post sets no status for a run it never records.
	const url = kixelUrl(deps.env);
	const token = requireToken(url, deps.env);
	const pull = await openPull(root, reviewed.base.ref, reviewed.branch, deps);
	if ("skipped" in pull) return pull;
	// A fork's own PR posts only where Kixel Quest serves the fork; elsewhere its status alone records the run, which
	// is all the fork's land gate reads.
	const [owner, repo] = pull.repository.split("/") as [string, string];
	const unposted =
		pull.fork && !(await new KixelQuest(url, token, deps, false).serves({ owner, repo }))
			? `${url} does not serve ${pull.repository}`
			: null;
	const outcome = runOutcome(reviewed);
	const mergeBase = git(root, ["merge-base", reviewed.base.sha, reviewed.head]);
	const attest = (state: "success" | "failure") =>
		pull.attest({
			head: reviewed.head,
			from: mergeBase,
			state,
			description: attestation(
				{
					tier: reviewed.risk.tier,
					class: reviewed.risk.classified.class,
					riskFile: riskFileId(reviewed.risk.classified.riskFile),
				},
				outcome,
			),
		});
	// The fork's base is the remote's configured name, which a rewritten fetch URL, such as a mirror, may not serve, so
	// the merge base this checkout reviewed from must be the one the fork's land gate binds the status to.
	if (pull.fork) {
		const theirs = await pull.mergeBase(reviewed.head);
		if (theirs !== null && theirs !== mergeBase)
			return {
				url: pull.url,
				status: {
					refused: `GitHub's merge base of ${reviewed.head} with ${pull.repository}'s ${pull.base} is ${theirs}, but this checkout reviewed it from ${mergeBase}; fetch ${pull.base} from ${pull.repository} itself, then review it again`,
				},
			};
	}
	const at = { repository: pull.repository, number: pull.number };
	// With nothing to post, the run's status is set once, as it ends.
	if (unposted !== null) {
		const post = { post: { skipped: unposted, at } };
		const status = await attest(outcome === "findings open" ? "failure" : "success");
		return status === null ? { url: pull.url, ...post } : { url: pull.url, status, ...post };
	}
	const status = await attest("failure");
	// An acceptance no status records has not happened, so nothing posts it.
	if (status !== null && reviewed.accepted !== undefined) return { url: pull.url, status };
	await postReviews(url, token, deps.fetch, {
		runs: [reviewRun(reviewed, { ...at, base: pull.base, mergeBase })],
		outcomes: reviewed.outcomes(at),
	});
	reviewed.posted?.(at);
	// A status the token could not set before would fail the same way again.
	if (status === null && outcome !== "findings open") {
		const passed = await attest("success");
		if (passed !== null) return { url: pull.url, status: passed };
	}
	return status === null ? { url: pull.url } : { url: pull.url, status };
}

/** How a run left its head, as its status and post name it. */
function runOutcome(reviewed: Reviewed): RunOutcome {
	if (!passed(reviewed)) return "findings open";
	if (reviewed.accepted !== undefined) return "findings accepted";
	return reviewed.rounds.length === 0 ? "passed with no local reviewer" : "passed";
}

/** A run as Kixel Quest stores it, for PR `number` of `repository` into `base`, its head diffed from `mergeBase`. */
export function reviewRun(
	reviewed: Reviewed,
	pull: { repository: string; number: number; base: string; mergeBase: string },
): ReviewRun {
	const { risk } = reviewed;
	const by = risk.classified.by;
	return {
		repository: pull.repository,
		number: pull.number,
		head: reviewed.head,
		base: { ref: pull.base, sha: pull.mergeBase },
		risk: {
			tier: risk.tier,
			reason: risk.reason,
			classified: risk.classified.tier,
			class: risk.classified.class,
			classifier:
				by.kind === "model"
					? { harness: by.harness, model: by.model, effort: by.effort, session: by.session }
					: null,
			riskFile: riskFileId(risk.classified.riskFile),
		},
		outcome: runOutcome(reviewed),
		rounds: reviewed.rounds.map((round) => ({
			harness: round.reviewer,
			model: round.model,
			effort: round.effort,
			seat: round.second ? "second" : "pick",
			session: round.session,
			round: round.round,
			score: round.score,
			rationale: round.rationale,
			findings: round.findings.map((finding) => ({
				path: finding.file,
				start: finding.line,
				end: finding.line,
				severity: finding.severity,
				title: finding.title,
			})),
		})),
	};
}

/** POST `upload` to Kixel Quest at `url` with `token`, after checking it is one its own `parseReviews` takes. */
async function postReviews(
	url: string,
	token: string,
	fetch: typeof globalThis.fetch,
	upload: ReviewUpload,
): Promise<void> {
	try {
		parseReviews(upload);
	} catch (error) {
		throw new Error(`this quest built a review post its own parseReviews refuses: ${(error as Error).message}`);
	}
	const endpoint = `${url}/reviews`;
	let response: Response;
	let text: string;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			// The token is Kixel Quest's alone, so it follows no redirect elsewhere.
			redirect: "error",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "quest",
			},
			body: JSON.stringify(upload),
		});
		text = await response.text();
	} catch (error) {
		throw new Error(
			`posting the run to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (response.ok) return;
	let why = text.slice(0, 500);
	try {
		const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
		if (typeof error === "string") why = error;
	} catch {}
	const retry = response.headers.get("retry-after");
	throw new Error(
		`${endpoint} answered HTTP ${response.status}: ${why}${retry === null ? "" : `; try again in ${retry} seconds`}`,
	);
}
