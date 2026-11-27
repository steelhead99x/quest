// GitHub's backend for the forge writes: REST and GraphQL for opening, editing, commenting, and threads, and the
// label holds and landing `quest iterate`, `ready`, `release`, and `merge` already make.
import {
	type ForgeWrites,
	type Hold,
	type OpenPull,
	type Opening,
	type Pick,
	type PullRequest,
	Refusal,
	handedBack,
} from "../core";
import { GitHub, type GitHubDependencies, object, repositoryPath, string } from "../github/client";
import { finish, land, release, take } from "./hold";
import type { LandingCheck } from "./landed";

/** The review thread a node ID names, with the PR it belongs to. */
const THREAD = `query($id: ID!) {
	node(id: $id) { __typename ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } }
}`;

/** Writes to GitHub, as the token in `deps` may. */
export class GitHubWrites implements ForgeWrites {
	readonly #github: GitHub;

	/** `check` is the quest check a pick runs on the head first; see `land`. */
	constructor(
		private readonly deps: GitHubDependencies,
		private readonly check: LandingCheck,
	) {
		this.#github = new GitHub(deps);
	}

	async open({ repository, head, branch, base, title, body, draft }: Opening): Promise<OpenPull> {
		const fork = head.owner !== repository.owner || head.repo !== repository.repo;
		// GitHub needs `head_repo` to tell apart two repositories of one owner, such as an organization's fork.
		const from = fork
			? { head: `${head.owner}:${branch}`, head_repo: `${head.owner}/${head.repo}` }
			: { head: branch };
		const response = await this.#github.request(`${repositoryPath(repository)}/pulls`, {
			body: { title, ...from, base, draft, body },
		});
		const row = object(await response.json());
		return {
			number: Number(row.number),
			url: string(row.html_url),
			branch,
			base,
			head: `${head.owner}/${head.repo}`,
			draft,
			created: Date.parse(string(row.created_at)),
			updated: Date.parse(string(row.created_at)),
			handedBack: handedBack(body),
			body,
		};
	}

	async close(pull: PullRequest): Promise<void> {
		await this.#github.request(this.#path(pull), { method: "PATCH", body: { state: "closed" } });
	}

	async edit(pull: PullRequest, { title, body }: { title: string | null; body: string | null }): Promise<void> {
		await this.#github.request(this.#path(pull), {
			method: "PATCH",
			body: { ...(title === null ? {} : { title }), ...(body === null ? {} : { body }) },
		});
	}

	async comment(pull: PullRequest, { body, thread }: { body: string; thread: string | null }): Promise<string> {
		if (thread === null) {
			const response = await this.#github.request(`${repositoryPath(pull)}/issues/${pull.number}/comments`, {
				body: { body },
			});
			return string(object(await response.json()).html_url);
		}
		await this.#thread(pull, thread);
		const data = await this.#github.graphql(
			`mutation($id: ID!, $body: String!) {
				addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { url } }
			}`,
			{ id: thread, body },
		);
		return string(object(object(data.addPullRequestReviewThreadReply).comment).url);
	}

	async resolve(pull: PullRequest, thread: string): Promise<void> {
		await this.#thread(pull, thread);
		await this.#github.graphql(
			"mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
			{ id: thread },
		);
	}

	hold(pull: PullRequest, token: string | null): Promise<Hold> {
		return take(pull, token, this.deps);
	}

	ready(pull: PullRequest, token: string | null): Promise<Hold | null> {
		return finish(pull, token, this.deps);
	}

	release(pull: PullRequest, token: string): Promise<Hold> {
		return release(pull, token, this.deps);
	}

	pick(pull: PullRequest, { head, method, direct }: Pick): Promise<void> {
		return land(pull, { sha: head, method: method ?? undefined, direct, check: this.check }, this.deps);
	}

	#path(pull: PullRequest): string {
		return `${repositoryPath(pull)}/pulls/${pull.number}`;
	}

	/** Refuse a thread ID that names no review thread on `pull`, as one copied from another PR would. */
	async #thread(pull: PullRequest, id: string): Promise<void> {
		const node = (await this.#github.graphql(THREAD, { id })).node;
		const on = node === null || node === undefined ? null : object(node);
		const owner = on?.__typename === "PullRequestReviewThread" ? object(on.pullRequest) : null;
		const name = `${pull.owner}/${pull.repo}`.toLowerCase();
		if (
			owner === null ||
			Number(owner.number) !== pull.number ||
			string(object(owner.repository).nameWithOwner).toLowerCase() !== name
		)
			throw new Refusal(`${id} is not a review thread on ${name}#${pull.number}`);
	}
}
