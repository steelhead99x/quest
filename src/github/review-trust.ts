// Whose `## Review` record `quest status` counts: only one a `quest review` commit status attests, set on the reviewed
// head by a user with write access to the base repository, since anyone can write a SHA into their own PR's body.
import {
	type PullRequest,
	type RecordedRisk,
	REVIEW_MARK,
	RISK_FILE,
	type Repository,
	heldHigh,
	highHits,
	parseRiskFile,
	recordedRisk,
	reviewSection,
	riskFileId,
} from "../core";
import { GitHubDeadline, type GitHubReader, array, object, repositoryPath, string } from "./client";

/** The commit status context `quest review` sets on each head it records. */
export const REVIEW_CONTEXT = "quest review";

/** A run's outcome as its status names it, including whether a local reviewer ran, which a standing pick needs. */
export type Outcome = "passed" | "passed with no local reviewer" | "findings accepted" | "findings open";

/**
 * The status description `quest review` sets: the head's risk, class, and the base's risk file they were set against,
 * which the body's record must match, and its outcome.
 */
export function attestation(risk: Pick<RecordedRisk, "tier" | "class" | "riskFile">, outcome: Outcome): string {
	const kind = risk.class === null ? "" : `, class ${risk.class}`;
	const file = risk.riskFile === null ? "" : `, risk file ${risk.riskFile}`;
	return `Risk ${risk.tier}${kind}${file}: ${outcome}`;
}

/**
 * The status's target: the reviewed diff, from the merge base `from` to the head, which binds it to the base the
 * review read. The repository's name is lowercased, as GitHub matches it.
 */
export function reviewTarget(repository: Repository, from: string, sha: string): string {
	return `https://github.com/${repository.owner}/${repository.repo}/compare/${from}...${sha}`.toLowerCase();
}

const ATTESTED =
	/^Risk (low|medium|high)(?:, class ([a-z0-9-]+))?(?:, risk file ([0-9a-f]{12}|none))?: (passed|passed with no local reviewer|findings accepted|findings open)$/;

/** Repository permissions that can push. */
const WRITE = ["admin", "maintain", "write"];

const STATUS_QUERY = `query ReviewStatus($owner: String!, $repo: String!, $sha: GitObjectID!) {
	repository(owner: $owner, name: $repo) {
		object(oid: $sha) { ... on Commit { status { context(name: "${REVIEW_CONTEXT}") {
			state description targetUrl creator { __typename login }
		} } } }
	}
}`;

/** A PR body as `quest status` reads it, the head its status attests, and whether it attests a local reviewer's round. */
export interface Trusted {
	body: string;
	head: string | null;
	localReview: boolean;
}

/**
 * `body` as `quest status` reads its `## Review` record: as written when a `quest review` status attests the head the
 * section names last, else without the record, with a warning saying why unless it names no full SHA.
 */
export async function trustedReview(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	body: string,
	warn: (message: string) => void,
): Promise<Trusted> {
	const section = reviewSection(body);
	const text = section === null ? "" : body.slice(section.start, section.end);
	// As `reviewRecord` reads it: only a section holding `quest review`'s record names a head, by its last full SHA.
	const reviewed = text.includes(REVIEW_MARK) && text.match(/\b[0-9a-f]{40}\b/g)?.at(-1);
	// A section naming no head, as a record with a finding open, counts for none, so its risk and class print as none.
	if (!reviewed) return { body: section === null ? body : "", head: null, localReview: false };
	const attested = await attestedOutcome(github, pr, body, reviewed);
	if (typeof attested !== "string") return { body, head: reviewed, localReview: attested.localReview };
	warn(`${pr.owner}/${pr.repo}#${pr.number}'s ## Review record does not count: ${attested}`);
	return { body: "", head: null, localReview: false };
}

/** The most files GitHub's compare API lists. */
const FILE_LIMIT = 300;

/** The `quest review` status descriptions on a PR's commits, newest first, a page at a time. */
const TIERS_QUERY = `query ReviewTiers($owner: String!, $repo: String!, $number: Int!, $before: String) {
	repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
		commits(last: 100, before: $before) {
			pageInfo { hasPreviousPage startCursor }
			nodes { commit { oid status { context(name: "${REVIEW_CONTEXT}") { description } } } }
		}
	} }
}`;

/**
 * Why `sha`, the head of `pr` about to land, must wait for a new `quest review` round, or null when it may land.
 * A head `RISK.md` rates high lands only with a trusted record whose reviewed diff is `sha`'s and that was classified
 * against the base's current risk file, so any push after the last review that changes the diff, whoever made it,
 * and any change to the base's risk file since, waits for a new one. A head is high when `body`'s record rates it
 * high, is malformed, or does not count, when a `quest review` status on any of the PR's commits rates it high, or
 * when its diff from its merge base with the base touches a path the base's risk file holds high.
 */
export async function unreviewedHigh(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	sha: string,
	body: string,
): Promise<string | null> {
	let distrust: string | undefined;
	const trusted = await trustedReview(github, pr, body, (message) => {
		distrust = message;
	});
	const head = sha.toLowerCase();
	const risk = await baseRisk(github, pr);
	// A record classified against another risk file may hold a tier the base no longer gives, so it covers nothing.
	const recorded = recordedRisk(body);
	const covers =
		recorded !== null && !("malformed" in recorded) && recorded.riskFile === riskFileId(risk?.blob ?? null);
	if (covers && trusted.head === head) return null;
	// A review of an earlier head carries to one with its diff, unless a round on this head has failed since.
	if (
		covers &&
		trusted.head !== null &&
		!(await failed(github, pr, head)) &&
		(await sameDiff(github, pr, trusted.head, head))
	)
		return null;
	const high =
		distrust ??
		recordHigh(body) ??
		(await statusHigh(github, pr)) ??
		(await pathHigh(github, pr, head, risk?.text ?? null));
	return high === null ? null : `${sha} is high, since ${high}, and no quest review status covers it`;
}

const BASE_RISK_QUERY = `query BaseRisk($owner: String!, $repo: String!, $expression: String!) {
	repository(owner: $owner, name: $repo) {
		object(expression: $expression) { oid ... on Blob { text isBinary isTruncated } }
	}
}`;

/**
 * The base branch's risk file and its blob SHA, read together, as `quest review` reads them from Git: a symlink's own
 * blob, BOM and all. Null where it has none.
 */
async function baseRisk(
	github: GitHubReader,
	pr: PullRequest & { base: string },
): Promise<{ text: string; blob: string } | null> {
	const data = await github.graphql(BASE_RISK_QUERY, {
		owner: pr.owner,
		repo: pr.repo,
		// Fully qualified, so a tag of the same name is never read instead.
		expression: `refs/heads/${pr.base}:${RISK_FILE}`,
	});
	const found = object(data.repository).object;
	if (found == null) return null;
	const blob = object(found);
	if (blob.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== "string")
		throw new Error(`${pr.owner}/${pr.repo}'s ${RISK_FILE} on ${pr.base} is not a text file GitHub returns whole`);
	return { text: blob.text, blob: string(blob.oid) };
}

/** Whether `sha` carries a `quest review` status that is not a pass. */
async function failed(github: GitHubReader, pr: PullRequest, sha: string): Promise<boolean> {
	const commit = object(
		(await github.graphql(STATUS_QUERY, { owner: pr.owner, repo: pr.repo, sha })).repository,
	).object;
	const rollup = commit == null ? null : object(commit).status;
	const status = rollup == null ? null : object(rollup).context;
	return status != null && object(status).state !== "SUCCESS";
}

/** Whether `a` and `b` have the same diff from their merge bases with the base. One GitHub cannot diff has none. */
async function sameDiff(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	a: string,
	b: string,
): Promise<boolean> {
	const diffs: string[] = [];
	for (const sha of [a, b]) {
		const response = await github.request(`${repositoryPath(pr)}/compare/${encodeURIComponent(pr.base)}...${sha}`, {
			accept: "application/vnd.github.diff",
			allow: [404, 406, 422],
		});
		if (!response.ok) return false;
		diffs.push(await response.text());
	}
	return diffs[0] === diffs[1];
}

/** Why `body`'s risk record makes its PR high, or null. A malformed one does, since the PR's author writes the body. */
function recordHigh(body: string): string | null {
	const risk = recordedRisk(body);
	if (risk === null) return null;
	if ("malformed" in risk) return risk.malformed;
	return risk.tier === "high" ? "its review record rates it high" : null;
}

/**
 * Why a `quest review` status on one of `pr`'s commits makes it high, or null. Only someone who can push sets one, and
 * a high rating only holds a head back, so the body, which its author can edit, never lowers it.
 */
async function statusHigh(github: GitHubReader, pr: PullRequest): Promise<string | null> {
	// GitHub lists at most 250 commits of a PR, so this reads at most three pages.
	for (let before: string | null = null, more = true; more;) {
		const data = await github.graphql(TIERS_QUERY, { owner: pr.owner, repo: pr.repo, number: pr.number, before });
		const commits = object(object(object(data.repository).pullRequest).commits);
		for (const node of array(commits.nodes)) {
			const commit = object(node.commit);
			const status = commit.status == null ? null : object(commit.status).context;
			const description = status == null ? null : object(status).description;
			if (typeof description === "string" && ATTESTED.exec(description)?.[1] === "high")
				return `the ${REVIEW_CONTEXT} status on ${string(commit.oid)} rates it high`;
		}
		const page = object(commits.pageInfo);
		more = page.hasPreviousPage === true;
		before = more ? string(page.startCursor) : null;
	}
	return null;
}

/**
 * Why `sha`'s diff from its merge base with the base makes it high, or null: it touches a path `risk`, the base's risk file,
 * holds high, on either side of a rename, as `quest review` classifies a head.
 */
async function pathHigh(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	sha: string,
	risk: string | null,
): Promise<string | null> {
	const path = repositoryPath(pr);
	const file = risk === null ? null : parseRiskFile(risk);
	if (file !== null && file.problems.length > 0)
		return `the base's ${RISK_FILE} cannot be read: ${file.problems.join("; ")}`;
	// The compare of `sha` itself, since GitHub recomputes a PR's file list only some time after a push.
	const compared = object(
		await (await github.request(`${path}/compare/${encodeURIComponent(pr.base)}...${sha}`)).json(),
	);
	const files = array(compared.files);
	if (files.length >= FILE_LIMIT) return `it changes at least ${FILE_LIMIT} files, more than GitHub lists`;
	const hit = highHits(
		heldHigh(file),
		files.flatMap((row) => [
			string(row.filename),
			...(typeof row.previous_filename === "string" ? [row.previous_filename] : []),
		]),
	)[0];
	return hit === undefined ? null : `it changes ${hit.path}, which is always high: ${hit.rule.reason}`;
}

/** Whether a writer's passing `quest review` status on `sha` attests `body`'s record, with a local reviewer or not, or why not. */
async function attestedOutcome(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	body: string,
	sha: string,
): Promise<{ localReview: boolean } | string> {
	const data = await github.graphql(STATUS_QUERY, { owner: pr.owner, repo: pr.repo, sha });
	const commit = object(data.repository).object;
	if (commit === null) return `${pr.owner}/${pr.repo} has no commit ${sha}`;
	const rollup = object(commit).status;
	const status = rollup == null ? null : object(rollup).context;
	if (status == null) return `${sha} has no ${REVIEW_CONTEXT} status`;
	const { state, description, targetUrl, creator } = object(status);
	if (state !== "SUCCESS")
		return `the ${REVIEW_CONTEXT} status on ${sha} is ${String(state).toLowerCase()}, not success`;
	if (creator == null) return `the account that set the ${REVIEW_CONTEXT} status on ${sha} is gone`;
	const { __typename: kind, login } = object(creator);
	const name = String(login);
	if (kind !== "User")
		return `${name}, who set the ${REVIEW_CONTEXT} status on ${sha}, is a ${String(kind)}, not a user`;
	const permission = await github.request(
		`/repos/${pr.owner}/${pr.repo}/collaborators/${encodeURIComponent(name)}/permission`,
		{ allow: [403, 404] },
	);
	if (permission.status === 403)
		return `cannot read the permission of ${name}, who set the ${REVIEW_CONTEXT} status on ${sha}: ${String(object(await permission.json()).message)}`;
	const found = permission.status === 404 ? "no" : string(object(await permission.json()).permission);
	if (!WRITE.includes(found))
		return `${name}, who set the ${REVIEW_CONTEXT} status on ${sha}, has ${found} access to ${pr.owner}/${pr.repo}, not write`;
	// A retargeted PR, or a base reset under it, has another diff than the one reviewed, from another merge base.
	let compared: Response;
	try {
		compared = await github.request(
			`/repos/${pr.owner}/${pr.repo}/compare/${encodeURIComponent(pr.base)}...${sha}?per_page=1`,
			{ allow: [404, 422] },
		);
	} catch (error) {
		// A deadline is the caller's to handle; any other failure leaves the record unverified, not the PR unread.
		if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
		return `GitHub cannot compare ${sha} with ${pr.base}: ${error.message}`;
	}
	if (!compared.ok) return `GitHub cannot compare ${sha} with ${pr.base} (HTTP ${compared.status})`;
	const from = string(object(object(await compared.json()).merge_base_commit).sha);
	// The status lives in this repository, so its target's diff binds it, whatever name the reader's remote gives it.
	if (!String(targetUrl).toLowerCase().endsWith(`/compare/${from}...${sha}`))
		return `the ${REVIEW_CONTEXT} status on ${sha} attests another diff than ${pr.base}'s, from ${from}: ${String(targetUrl)}`;
	// The tier, class, and risk file gate a standing pick, so the body's must be the ones attested.
	const attested = ATTESTED.exec(typeof description === "string" ? description : "");
	if (attested === null) return `the ${REVIEW_CONTEXT} status on ${sha} names no risk: ${String(description)}`;
	const risk = recordedRisk(body);
	if (risk === null) return `it names no risk, which the ${REVIEW_CONTEXT} status on ${sha} attests`;
	// A malformed risk is left for `quest status` to print and `quest merge` to refuse.
	if (
		!("malformed" in risk) &&
		(risk.tier !== attested[1] || risk.class !== (attested[2] ?? null) || risk.riskFile !== (attested[3] ?? null))
	)
		return `its risk differs from the ${REVIEW_CONTEXT} status on ${sha}: ${String(description)}`;
	return { localReview: attested[4] !== "passed with no local reviewer" };
}
