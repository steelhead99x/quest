// What holds a PR's head from landing besides its checks: a finding on the head that no writer has answered, from an
// online reviewer the base requires, and a maintainer decision recorded in a comment after the head was committed that
// nothing has answered. An optional reviewer's findings, such as CodeRabbit's on a base that requires none of its
// checks, are suggestions and hold nothing.
import type { Repository, Signal } from "../core";
import { type GitHubReader, type ObjectValue, array, object, string } from "./client";
import { type Activity, bodyFindings, isBot, login, readActivity, reviewerOf } from "./online-review";

/** The picked heads whose signals a later commit carries unread, and when the pick was made. */
export interface Carried {
	heads: string[];
	picked: string;
}

/**
 * The marker a comment's first line opens with to record a maintainer decision, after markup such as `**` but not in
 * a quote or code, which four leading spaces or a tab also start.
 */
export const DECISION = /^ {0,3}(?![ \t])[^A-Za-z>`~\n]*Maintainer decision\b/i;

/** Repository permissions that can push, whose decisions and answers count. */
const WRITE = ["admin", "maintain", "write"];

/** A body's first line of prose, past markup such as a bot's HTML comments and images, cut short. */
const firstLine = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->|<[^>\n]*>/g, "")
		.split("\n")
		.map((line) => line.replace(/\*\*|__/g, "").trim())
		.find((line) => /[A-Za-z]/.test(line))
		?.slice(0, 120) ?? "";

/** The `#...` anchor of a GitHub URL. */
const anchorOf = (url: string) => url.slice(url.lastIndexOf("#"));

/** Whether `body` links `url`'s anchor whole, not as the start of a longer ID such as `#issuecomment-90` for `-9`. */
const links = (body: string, url: string) =>
	body
		.split(anchorOf(url))
		.slice(1)
		.some((rest) => !/^[\w-]/.test(rest));

/** A signal as {@link signals} finds it: a finding also names the bot account that posted it, if any, and its commit. */
export type Found = Signal & { poster?: string | null; commit?: string };

/**
 * The signals on `pull`'s head, given which accounts can push to its repository, before {@link readSignals} drops
 * those of reviewers the base does not require. A finding is an online
 * reviewer's, from its latest pass over the head: a review thread it opened that is unresolved with no writer's reply,
 * or a `[P<n>]` line of that pass's body that no writer's later comment links. A
 * decision is a writer's comment opening with {@link DECISION}, posted after the head was committed, that no writer's
 * later comment links: a head committed before a decision cannot have applied it. A bot is never a writer.
 * `carried` names heads a writer picked that a commit since carries forward unread, such as the land fixer's: findings on
 * them hold too, and so does a decision posted after its pick.
 */
export function signals(pull: Activity, writers: ReadonlySet<string>, carried?: Carried): Found[] {
	const writer = (actor: unknown) => !isBot(actor) && writers.has(login(actor) ?? "");
	const found: Found[] = [];
	const heads = new Set([pull.head, ...(carried?.heads ?? [])]);
	const reviews = pull.reviews.map((review) => ({
		id: String(review.id),
		url: String(review.url),
		// A review names its reviewer in its body only under a bot's or a writer's account, so a forged one replaces nothing.
		reviewer: isBot(review.author) || writer(review.author) ? reviewerOf(review) : null,
		// The account whose required check can make the reviewer required: a bot's, never a person's.
		poster: isBot(review.author) ? login(review.author) : null,
		body: typeof review.body === "string" ? review.body : "",
		at: Date.parse(String(review.submittedAt)),
		commit: review.commit != null ? String(object(review.commit).oid) : "",
		// A dismissed review is withdrawn: it holds nothing.
		head: review.state !== "DISMISSED" && review.commit != null && heads.has(String(object(review.commit).oid)),
	}));
	const byId = new Map(reviews.map((review) => [review.id, review]));
	const opened = new Set(
		pull.reviewThreads.flatMap((thread) => {
			const review = array(object(thread.comments).nodes)[0]?.pullRequestReview;
			return review ? [String(object(review).id)] : [];
		}),
	);
	const comments = pull.comments
		.map((comment) => ({
			author: comment.author,
			writer: writer(comment.author),
			body: String(comment.body ?? ""),
			url: String(comment.url ?? ""),
			at: Date.parse(String(comment.createdAt)),
		}))
		.sort((a, b) => a.at - b.at);

	for (const thread of pull.reviewThreads) {
		if (thread.isResolved === true) continue;
		const [first, ...replies] = array(object(thread.comments).nodes);
		const opener = first?.pullRequestReview ? byId.get(String(object(first.pullRequestReview).id)) : undefined;
		if (!opener?.reviewer || !opener.head) continue;
		// A named reviewer posts under a person's account, so only its name, on the reply or the review holding it, tells
		// its replies from an answer.
		const own = (comment: ObjectValue) =>
			opener.body.startsWith("Automated review by") &&
			(reviewerOf(comment) === opener.reviewer ||
				(comment.pullRequestReview != null &&
					byId.get(String(object(comment.pullRequestReview).id))?.reviewer === opener.reviewer));
		if (replies.some((reply) => !own(reply) && writer(reply.author))) continue;
		found.push({
			kind: "finding",
			url: String(first!.url ?? opener.url),
			author: opener.reviewer,
			text: firstLine(String(first!.body ?? "")),
			poster: opener.poster,
			commit: opener.commit,
		});
	}

	// Each reviewer's latest pass over each head lists what it still finds there; a pass may only open threads. A late
	// pass over a carried head says nothing of another, nor one posted under another account of one under a bot's.
	const latest = new Map<string, (typeof reviews)[number]>();
	for (const review of reviews)
		if (review.reviewer !== null && review.head && (review.body.trim() !== "" || opened.has(review.id))) {
			const key = `${review.reviewer}\n${review.poster ?? ""}\n${review.commit}`;
			const prior = latest.get(key);
			if (!prior || prior.at <= review.at) latest.set(key, review);
		}
	const passes = [...latest.values()]
		.map((pass) => ({ ...pass, titles: bodyFindings(pass.body).map((finding) => finding.title), answered: false }))
		.filter((pass) => pass.titles.length > 0)
		.sort((a, b) => a.at - b.at);
	// A writer answers a pass by linking it; an answer word alone cannot tell which finding it meant.
	for (const pass of passes)
		pass.answered = comments.some(
			(comment) => comment.writer && comment.at >= pass.at && links(comment.body, pass.url),
		);
	for (const pass of passes)
		if (!pass.answered)
			for (const title of pass.titles)
				found.push({
					kind: "finding",
					url: pass.url,
					author: pass.reviewer!,
					text: title,
					poster: pass.poster,
					commit: pass.commit,
				});

	const committed = Math.min(Date.parse(pull.committed), carried ? Date.parse(carried.picked) : Infinity);
	for (const decision of comments) {
		if (!decision.writer || !DECISION.test(decision.body) || decision.at <= committed) continue;
		if (comments.some((reply) => reply.writer && reply.at > decision.at && links(reply.body, decision.url)))
			continue;
		found.push({
			kind: "decision",
			url: decision.url,
			author: login(decision.author) ?? "-",
			text: firstLine(decision.body),
		});
	}
	return found;
}

/**
 * Which of `logins` can push to `repository`. An author association of OWNER can; MEMBER and COLLABORATOR may only
 * read, so their permission is read; any other association cannot.
 */
async function writersOf(
	client: GitHubReader,
	repository: Repository,
	actors: { actor: unknown; association: unknown }[],
): Promise<Set<string>> {
	const writers = new Set<string>();
	const asked = new Set<string>();
	for (const { actor, association } of actors) {
		const name = login(actor);
		if (name === null || isBot(actor)) continue;
		if (association === "OWNER") writers.add(name);
		else if ((association === "MEMBER" || association === "COLLABORATOR") && !asked.has(name)) {
			asked.add(name);
			const response = await client.request(
				`/repos/${repository.owner}/${repository.repo}/collaborators/${encodeURIComponent(name)}/permission`,
				{ allow: [404] },
			);
			if (response.status !== 404 && WRITE.includes(string(object(await response.json()).permission)))
				writers.add(name);
		}
	}
	return writers;
}

/** The head's check contexts, each with whether the PR's base requires it and the account that posts it. */
const REQUIRED = `query RequiredPosters($owner: String!, $name: String!, $number: Int!, $oid: GitObjectID!, $after: String) {
	repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup {
		contexts(first: 100, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				__typename
				... on CheckRun { isRequired(pullRequestNumber: $number) checkSuite { app { slug } } }
				... on StatusContext { isRequired(pullRequestNumber: $number) creator { __typename login } }
			}
		}
	} } } }
}`;

/**
 * The accounts that post a check `number`'s base requires on `head`, as GitHub judges it for the PR: a check run's app
 * as its bot, and a commit status's creator. A reviewer posting under one of them is one the base requires. Every
 * GitHub Actions workflow posts as `github-actions[bot]`, so a reviewer posting as that account is required wherever
 * any Actions job is, and one posting as its own bot from a required workflow is not.
 */
export async function requiredPosters(
	client: GitHubReader,
	repository: Repository,
	number: number,
	head: string,
): Promise<Set<string>> {
	const posters = new Set<string>();
	for (let after: string | null = null; ;) {
		const data = await client.graphql(REQUIRED, {
			owner: repository.owner,
			name: repository.repo,
			number,
			oid: head,
			after,
		});
		const commit = object(data.repository).object;
		if (commit === null || commit === undefined) throw new Error(`commit ${head} of PR #${number} is missing`);
		const rollup = object(commit).statusCheckRollup;
		if (rollup === null || rollup === undefined) return posters;
		const page = object(object(rollup).contexts);
		for (const context of array(page.nodes)) {
			if (context.isRequired !== true) continue;
			const app = object(object(context.checkSuite ?? {}).app ?? {});
			const poster =
				context.__typename === "CheckRun"
					? typeof app.slug === "string"
						? `${app.slug}[bot]`
						: null
					: login(context.creator);
			if (poster !== null) posters.add(poster);
		}
		const info = object(page.pageInfo);
		if (info.hasNextPage !== true) return posters;
		after = string(info.endCursor);
	}
}

/**
 * The signals on each PR's current head, by number, with the head they were read for, and those `carried` carries.
 * A finding holds only when the bot account that posted it also posts a check the base requires on the commit it
 * reviewed, which a carried head keeps after a push; an optional reviewer's, and one posted under a person's account,
 * are left out.
 */
export async function readSignals(
	client: GitHubReader,
	repository: Repository,
	numbers: number[],
	carried?: ReadonlyMap<number, Carried>,
): Promise<Map<number, { head: string; signals: Signal[] }>> {
	const pulls = await readActivity(client, repository, numbers);
	for (const [number, pull] of pulls)
		if (pull.moved) throw new Error(`the head of PR #${number} changed while it was read; retry`);
	const actors = [...pulls.values()].flatMap((pull) => [
		...pull.reviews.map((review) => ({ actor: review.author, association: review.authorAssociation })),
		...pull.comments.map((comment) => ({ actor: comment.author, association: comment.authorAssociation })),
		...pull.reviewThreads.flatMap((thread) =>
			array(object(thread.comments).nodes).map((comment) => ({
				actor: comment.author,
				association: comment.authorAssociation,
			})),
		),
	]);
	const writers = await writersOf(client, repository, actors);
	const read = new Map<number, { head: string; signals: Signal[] }>();
	for (const [number, pull] of pulls) {
		const found = signals(pull, writers, carried?.get(number));
		// Only a commit with a bot's finding pays for reading which accounts post the checks its base requires.
		const required = new Map<string, Set<string>>();
		for (const { poster, commit } of found)
			if (poster && commit && !required.has(commit))
				required.set(commit, await requiredPosters(client, repository, number, commit));
		read.set(number, {
			head: pull.head,
			signals: found
				.filter(
					({ kind, poster, commit }) =>
						kind !== "finding" || (!!poster && !!commit && required.get(commit)!.has(poster)),
				)
				.map(({ kind, url, author, text }) => ({ kind, url, author, text })),
		});
	}
	return read;
}

/** Signals as one line each, for a refusal or a comment. */
export function describe(found: Signal[]): string {
	return found.map((signal) => `${signal.kind} by ${signal.author}: ${signal.text} (${signal.url})`).join("; ");
}
