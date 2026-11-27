// A PR's title, body, and discussion as GitHub gives them: what `gh pr view --comments` shows, with its review
// threads' comments too.
import type { Comment, PullRequest, PullView } from "../core";
import { type GitHubReader, type ObjectValue, actor, array, object, string } from "./client";
import { readActivity } from "./online-review";

/** `pull`'s title, body, comments, submitted reviews, and review threads. */
export async function pullView(github: GitHubReader, pull: PullRequest): Promise<PullView> {
	const data = await github.graphql(
		"query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { " +
			"pullRequest(number: $number) { url title body state isDraft author { login } } } }",
		{ owner: pull.owner, name: pull.repo, number: pull.number },
	);
	const found = object(data.repository).pullRequest;
	if (found === null || found === undefined)
		throw new Error(`GitHub has no PR #${pull.number} in ${pull.owner}/${pull.repo} for this token`);
	const pr = object(found);
	const activity = (await readActivity(github, pull, [pull.number])).get(pull.number)!;
	return {
		url: string(pr.url),
		title: String(pr.title),
		author: actor(pr.author),
		state: String(pr.state).toLowerCase() as PullView["state"],
		draft: pr.isDraft === true,
		body: String(pr.body ?? ""),
		comments: activity.comments.map(comment),
		// A pending review is the viewer's own unsubmitted draft.
		reviews: activity.reviews
			.filter((review) => typeof review.submittedAt === "string")
			.map((review) => ({
				reviewer: actor(review.author),
				state: String(review.state).toLowerCase(),
				body: String(review.body ?? ""),
				commit: review.commit ? string(object(review.commit).oid) : null,
				submittedAt: String(review.submittedAt),
				url: string(review.url),
			})),
		threads: activity.reviewThreads.map((thread) => ({
			id: string(thread.id),
			path: String(thread.path),
			line:
				typeof thread.line === "number"
					? thread.line
					: typeof thread.originalLine === "number"
						? thread.originalLine
						: null,
			outdated: thread.isOutdated === true,
			resolved: thread.isResolved === true,
			comments: array(object(thread.comments).nodes).map(comment),
		})),
	};
}

function comment(node: ObjectValue): Comment {
	return {
		author: actor(node.author),
		body: String(node.body ?? ""),
		createdAt: String(node.createdAt),
		url: string(node.url),
	};
}
