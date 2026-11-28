// Which `quest review` commit statuses count: only one set on the reviewed head by a user with write access to the base
// repository, bound to the head's diff from its merge base. The land gate reads the review from them alone; `quest
// status` still counts a PR body's `## Review` record, which `quest review` once wrote, only where one attests it.
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
import { GitHubDeadline, type GitHubReader, type ObjectValue, array, object, repositoryPath, string } from "./client";

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
	return `Risk ${risk.tier}${kind}, risk file ${risk.riskFile}: ${outcome}`;
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

/**
 * The review the `quest review` statuses on `pr`'s commits attest by themselves, with no `## Review` record that counts,
 * as for a fork PR Kixel Quest does not serve, or null when none covers `head`. As the land gate picks it: the newest
 * status a writer set on a commit whose diff from the base is the head's decides, counting only when it passed against
 * `riskFile`, the base's current risk file blob, so a later failed round of the same diff outweighs an earlier pass.
 * `state` is `current` when that commit is the head, else `diff-identical`.
 */
export async function statusReview(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	head: string,
	riskFile: string | null,
): Promise<{
	state: "current" | "diff-identical";
	head: string;
	tier: string;
	class: string | null;
	localReview: boolean;
} | null> {
	const sha = head.toLowerCase();
	// A diff GitHub will not give leaves that commit's status out, as the land gate leaves it, without failing the read.
	const diffOf = async (oid: string) => {
		try {
			return await baseDiff(github, pr, oid);
		} catch (error) {
			if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
			return null;
		}
	};
	let diff: Promise<string | null> | undefined;
	for (const each of await reviewStatuses(github, pr)) {
		if (each.oid !== sha) {
			diff ??= diffOf(sha);
			const own = await diff;
			if (own === null || (await diffOf(each.oid)) !== own) continue;
		}
		const bound = await boundStatus(github, pr, each.oid, each.status);
		if (typeof bound === "string") continue;
		if (each.status.state !== "SUCCESS" || bound.riskFile !== riskFileId(riskFile)) return null;
		return {
			state: each.oid === sha ? "current" : "diff-identical",
			head: each.oid,
			tier: bound.tier,
			class: bound.class,
			localReview: bound.outcome !== "passed with no local reviewer",
		};
	}
	return null;
}

/** The most files GitHub's compare API lists. */
const FILE_LIMIT = 300;

/** The `quest review` statuses on a PR's commits, a page at a time from the newest page. */
const TIERS_QUERY = `query ReviewTiers($owner: String!, $repo: String!, $number: Int!, $before: String) {
	repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
		commits(last: 100, before: $before) {
			pageInfo { hasPreviousPage startCursor }
			nodes { commit { oid status { context(name: "${REVIEW_CONTEXT}") {
				state description targetUrl createdAt creator { __typename login }
			} } } }
		}
	} }
}`;

/** A commit's latest `quest review` status, as GitHub returns it. */
interface ReviewStatus {
	oid: string;
	status: ObjectValue;
}

/**
 * Why `sha`, the head of `pr` about to land, must wait for a new `quest review` round, or null when it may land.
 * The newest `quest review` status a writer set on a commit of the PR whose diff is the head's decides it: the head
 * lands whatever its tier when that status passed, classified against the base's current risk file, so a round that
 * failed outweighs an earlier pass of the same diff, and any push after the last review that changes the diff, whoever
 * made it, and any change to the base's risk file since, waits for a new one. Otherwise it waits when it is high: when
 * a `quest review` status on any of the PR's commits rates it high, or when its diff from its merge base with the base
 * touches a path the base's risk file holds high.
 */
export async function unreviewedHigh(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	sha: string,
): Promise<string | null> {
	const head = sha.toLowerCase();
	const risk = await baseRisk(github, pr);
	const statuses = await reviewStatuses(github, pr);
	let diff: Promise<string | null> | undefined;
	for (const each of statuses) {
		if (each.oid !== head) {
			diff ??= baseDiff(github, pr, head);
			const own = await diff;
			if (own === null || (await baseDiff(github, pr, each.oid)) !== own) continue;
		}
		// Only a writer's status, bound to the diff it reviewed, says anything about the head.
		const bound = await boundStatus(github, pr, each.oid, each.status);
		if (typeof bound === "string") continue;
		if (each.status.state === "SUCCESS" && bound.riskFile === riskFileId(risk?.blob ?? null)) return null;
		break;
	}
	const high = statusHigh(statuses) ?? (await pathHigh(github, pr, head, risk?.text ?? null));
	return high === null ? null : `${sha} is high, since ${high}, and no quest review status covers it`;
}

/**
 * The `quest review` statuses on `pr`'s commits, the most recently set first, since a checkout may review an older
 * commit after a newer one; GitHub lists at most 250 commits, so three pages.
 */
async function reviewStatuses(github: GitHubReader, pr: PullRequest): Promise<ReviewStatus[]> {
	const found: ReviewStatus[] = [];
	for (let before: string | null = null, more = true; more;) {
		const data = await github.graphql(TIERS_QUERY, { owner: pr.owner, repo: pr.repo, number: pr.number, before });
		const commits = object(object(object(data.repository).pullRequest).commits);
		for (const node of array(commits.nodes).reverse()) {
			const commit = object(node.commit);
			const status = commit.status == null ? null : object(commit.status).context;
			if (status != null) found.push({ oid: string(commit.oid).toLowerCase(), status: object(status) });
		}
		const page = object(commits.pageInfo);
		more = page.hasPreviousPage === true;
		before = more ? string(page.startCursor) : null;
	}
	const set = (each: ReviewStatus) => Date.parse(string(each.status.createdAt));
	return found.sort((a, b) => set(b) - set(a));
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

/** `sha`'s diff from its merge base with the base, or null for one GitHub cannot diff. */
async function baseDiff(github: GitHubReader, pr: PullRequest & { base: string }, sha: string): Promise<string | null> {
	const response = await github.request(`${repositoryPath(pr)}/compare/${encodeURIComponent(pr.base)}...${sha}`, {
		accept: "application/vnd.github.diff",
		allow: [404, 406, 422],
	});
	return response.ok ? await response.text() : null;
}

/**
 * Why a `quest review` status on one of the PR's commits makes it high, or null. Only someone who can push sets one, and
 * a high rating only holds a head back.
 */
function statusHigh(statuses: ReviewStatus[]): string | null {
	const high = statuses.find(({ status }) => {
		const description = status.description;
		return typeof description === "string" && ATTESTED.exec(description)?.[1] === "high";
	});
	return high === undefined ? null : `the ${REVIEW_CONTEXT} status on ${high.oid} rates it high`;
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
	const attested = await attestedStatus(github, pr, sha, object(status));
	if (typeof attested === "string") return attested;
	const risk = recordedRisk(body);
	if (risk === null) return `it names no risk, which the ${REVIEW_CONTEXT} status on ${sha} attests`;
	// A malformed risk is left for `quest status` to print.
	if (
		!("malformed" in risk) &&
		(risk.tier !== attested.tier || risk.class !== attested.class || risk.riskFile !== attested.riskFile)
	)
		return `its risk differs from the ${REVIEW_CONTEXT} status on ${sha}: ${String(object(status).description)}`;
	return { localReview: attested.outcome !== "passed with no local reviewer" };
}

/** What a `quest review` status attests: the head's risk, and the run's outcome. */
interface Attested {
	tier: string;
	class: string | null;
	riskFile: string;
	outcome: Outcome;
}

/**
 * The risk and outcome a writer's passing `quest review` status on `sha` attests for its diff from the merge base with
 * the PR's base, or why it attests nothing.
 */
async function attestedStatus(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	sha: string,
	status: ObjectValue,
): Promise<Attested | string> {
	if (status.state !== "SUCCESS")
		return `the ${REVIEW_CONTEXT} status on ${sha} is ${String(status.state).toLowerCase()}, not success`;
	return boundStatus(github, pr, sha, status);
}

/**
 * What a writer's `quest review` status on `sha`, in any state, attests for its diff from the merge base with the PR's
 * base, or why it attests nothing.
 */
async function boundStatus(
	github: GitHubReader,
	pr: PullRequest & { base: string },
	sha: string,
	status: ObjectValue,
): Promise<Attested | string> {
	const { description, targetUrl, creator } = status;
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
		// A deadline is the caller's to handle; any other failure leaves the status unverified, not the PR unread.
		if (error instanceof GitHubDeadline || !(error instanceof Error)) throw error;
		return `GitHub cannot compare ${sha} with ${pr.base}: ${error.message}`;
	}
	if (!compared.ok) return `GitHub cannot compare ${sha} with ${pr.base} (HTTP ${compared.status})`;
	const from = string(object(object(await compared.json()).merge_base_commit).sha);
	// The status lives in this repository, so its target's diff binds it, whatever name the reader's remote gives it.
	if (!String(targetUrl).toLowerCase().endsWith(`/compare/${from}...${sha}`))
		return `the ${REVIEW_CONTEXT} status on ${sha} attests another diff than ${pr.base}'s, from ${from}: ${String(targetUrl)}`;
	// The tier, class, and risk file gate a standing pick. A status that names no risk file came before it was
	// attested, and names none, as a record without the line does.
	const attested = ATTESTED.exec(typeof description === "string" ? description : "");
	if (attested === null) return `the ${REVIEW_CONTEXT} status on ${sha} names no risk: ${String(description)}`;
	return {
		tier: attested[1]!,
		class: attested[2] ?? null,
		riskFile: attested[3] ?? riskFileId(null),
		outcome: attested[4] as Outcome,
	};
}
