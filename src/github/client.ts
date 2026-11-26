// The GitHub client: authenticated REST and GraphQL requests with paging, retries, rate limits, and a deadline.
// No Node APIs, so it runs wherever `fetch` does; the caller supplies the token and clock.
import type { Repository } from "../core";
import { cancelled, currentContexts, latestContexts, type RollupContext, type WorkflowRun } from "./checks";

const API = "https://api.github.com";
const MAX_SLEEP = 2_147_483_647;

/**
 * What a read-only client needs from its host: `fetch`, a clock, a way to pause, the token it reads
 * with, where warnings go, and what to do once the token's hourly quota is spent. The read token may
 * be an App installation's, which can read but never write; a write takes {@link GitHubDependencies}.
 */
export interface GitHubReadDependencies {
	fetch: typeof fetch;
	now(): number;
	sleep(milliseconds: number): Promise<unknown>;
	readToken: string;
	warn(message: string): void;
	/**
	 * `wait` sleeps until a spent quota resets, up to an hour, for a daemon or a waiter whose job is to
	 * outlast it; `fail` fails at once, naming the reset, so a one-shot command never stalls on it.
	 */
	quota: "wait" | "fail";
	/** Where GET answers are kept to revalidate by ETag, so an unchanged read costs no quota; none when absent. */
	cache?: ResponseCache;
}

/**
 * What a client that writes needs: the same, with the person's own token, so what it writes is in their
 * name. It has no `readToken`, so it never stands in for read dependencies built on another token.
 */
export interface GitHubDependencies extends Omit<GitHubReadDependencies, "readToken"> {
	token: string;
}

/**
 * `deps` as read dependencies, reading on the person's own token. Each member is forwarded, called on `deps`, so a
 * host whose members are a class's methods keeps them and their receiver.
 */
export function reading(deps: GitHubDependencies): GitHubReadDependencies {
	return {
		fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			deps.fetch(input, init)) as typeof fetch,
		now: () => deps.now(),
		sleep: (milliseconds) => deps.sleep(milliseconds),
		warn: (message) => deps.warn(message),
		readToken: deps.token,
		quota: deps.quota,
		...(deps.cache === undefined ? {} : { cache: deps.cache }),
	};
}

/** A comment, block string, string, or name, possibly a variable's, at the start of a GraphQL document's rest. */
const TOKEN = /^(?:#[^\n\r]*|"""(?:\\"""|[^])*?"""|"(?:\\.|[^"\\\n\r])*"|\$?[_A-Za-z][_0-9A-Za-z]*)/;

/**
 * Whether a GraphQL document may define a mutation: whether `mutation` is a name outside every brace and parenthesis,
 * skipping comments and strings, since GraphQL lets an operation follow a comment, a comma, or a fragment. It errs
 * toward a mutation, as for a fragment or operation named `mutation`, which is never repeated blindly and which a
 * read-only client refuses.
 */
export function mutates(query: string): boolean {
	let depth = 0;
	for (let i = 0; i < query.length;) {
		const token = TOKEN.exec(query.slice(i));
		if (token) {
			if (depth === 0 && token[0] === "mutation") return true;
			i += token[0].length;
			continue;
		}
		const char = query[i++];
		if (char === "{" || char === "(") depth++;
		else if ((char === "}" || char === ")") && depth > 0) depth--;
	}
	return false;
}

/** A 200 answer to a GET, kept to serve when GitHub answers its ETag with a 304. */
export interface CachedResponse {
	etag: string;
	headers: [string, string][];
	body: string;
}

/** Stored GET answers by an opaque key, a hex SHA-256 that covers the token, so no token is stored. */
export interface ResponseCache {
	get(key: string): Promise<CachedResponse | undefined>;
	set(key: string, entry: CachedResponse): Promise<void>;
}

/** A request or pause reached the client's deadline; the caller decides what that means. */
export class GitHubDeadline extends Error {
	constructor() {
		super("deadline reached");
	}
}

/** GitHub answered a GraphQL operation with errors; `types` are their types, `undefined` for an untyped one. */
export class GitHubGraphQLError extends Error {
	constructor(
		readonly types: (string | undefined)[],
		messages: string[],
	) {
		super(`GitHub GraphQL error: ${messages.join("; ")}`);
	}
}

/** A JSON object from a GitHub response. */
export type ObjectValue = Record<string, unknown>;

/** Retries of a 5xx or a dropped connection, waiting 1, 2, 4, then 8 seconds unless GitHub says how long. */
const TRANSIENT_RETRIES = 4;
const backoff = (failures: number) => 1000 * 2 ** failures;
/** How far GitHub's clock may run behind ours, as when looking for what a lost request created. */
export const CLOCK_SKEW = 60_000;
/** Statuses whose response has no body. */
const NULL_BODY = [204, 205];

/**
 * Whether a request may repeat after a 5xx or a dropped connection, after which GitHub may have
 * acted anyway: `true` when repeating leaves the same state, or a check, run before each repeat,
 * for the response of an earlier attempt that took effect (undefined if none did).
 */
export type Repeat = boolean | ((started: number) => Promise<Response | undefined>);

/** How {@link GitHub.request} sends a request and which refusals it returns rather than throws. */
export interface RequestOptions {
	body?: unknown;
	method?: "POST" | "PUT" | "PATCH" | "DELETE";
	allow?: number[];
	/** A media type other than JSON, such as `application/vnd.github.diff`. */
	accept?: string;
	/** Overrides how the request repeats; the default follows its method and endpoint. */
	repeat?: Repeat;
}

/** Whether GitHub turned a request away for a rate limit, which any request may wait out and repeat. */
function limited(response: Response, body: string): boolean {
	return (
		response.status === 429 ||
		(response.status === 403 &&
			(response.headers.has("retry-after") ||
				response.headers.get("x-ratelimit-remaining") === "0" ||
				/rate limit/i.test(body)))
	);
}

/** How {@link GitHubReader.request} reads: a GET, so it takes neither method nor body. */
export type ReadOptions = Pick<RequestOptions, "allow" | "accept">;

/**
 * Authenticated REST GETs and GraphQL queries that wait out rate limits, bounded by an optional deadline. It
 * cannot write, so it may hold an installation token; {@link GitHub} writes too, on the person's own.
 */
export class GitHubReader {
	/** The longest X-Poll-Interval GitHub asked for since the caller last set this, in milliseconds. */
	pollInterval = 0;
	/** The response cache, dropped after its first failure. */
	private cache: ResponseCache | undefined;

	constructor(
		protected readonly deps: GitHubReadDependencies,
		protected readonly deadline = Infinity,
	) {
		this.cache = deps.cache;
	}

	/** The `owner/name` of the repository with `id`, or null when the read token cannot see it. */
	async repositoryName(id: number): Promise<string | null> {
		const response = await this.request(`/repositories/${id}`, { allow: [404] });
		return response.ok ? string(object(await response.json()).full_name) : null;
	}

	/**
	 * The lowercase `owner/name` that `repository` is served under now, as GitHub's redirect from a transferred or
	 * renamed repository's former name answers; null when it serves none there, or the read token cannot see it.
	 */
	async currentName(repository: Repository): Promise<string | null> {
		const response = await this.request(repositoryPath(repository), { allow: [403, 404, 451] });
		if (!response.ok) return null;
		const body = object(await response.json());
		return `${string(object(body.owner).login)}/${string(body.name)}`.toLowerCase();
	}

	/**
	 * A cache operation's result, or undefined once it fails: the cache only saves quota, so a full
	 * or unwritable disk warns once and leaves the client reading GitHub uncached.
	 */
	private async cached<T>(operation: () => Promise<T>): Promise<T | undefined> {
		if (!this.cache) return undefined;
		try {
			return await operation();
		} catch (error) {
			this.cache = undefined;
			this.deps.warn(`GitHub response cache failed, reading uncached: ${message(error)}`);
			return undefined;
		}
	}

	/** Sleep, cut short by the deadline. */
	async pause(milliseconds: number): Promise<void> {
		const remaining = this.deadline - this.deps.now();
		if (remaining <= 0) throw new GitHubDeadline();
		await this.deps.sleep(Math.min(milliseconds, remaining, MAX_SLEEP));
		if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
	}

	/** A GET: see {@link GitHubReader.send}. */
	request(path: string, options: ReadOptions = {}): Promise<Response> {
		return this.send(path, options);
	}

	/**
	 * A 2xx response, its body already read; anything else fails, with GitHub's reason when it gives
	 * one, unless `allow` lists its status. A GET revalidates the cached answer by its ETag and serves
	 * it on a 304, under the 304's own headers. Rate limits are waited out. A 5xx or a
	 * connection dropped before the body is in, after which GitHub may or may not have acted, is
	 * retried with bounded backoff as `repeat` allows, then fails with the last error. `body` makes
	 * it a POST unless `method` says otherwise.
	 */
	protected async send(path: string, options: RequestOptions = {}): Promise<Response> {
		// Follow only same-origin pagination links; never send a token to another host.
		const url = new URL(path, API);
		if (url.origin !== API || url.username || url.password) throw new Error("invalid GitHub pagination URL");
		const started = this.deps.now();
		const repeat = options.repeat ?? (await this.repeatable(url, options, started));
		const accept = options.accept ?? "application/vnd.github+json";
		const get = options.body === undefined && options.method === undefined;
		const cache = get ? this.cache : undefined;
		const key = cache && (await cacheKey(this.deps.readToken, accept, url.href));
		const cached = key === undefined ? undefined : await this.cached(() => cache!.get(key));
		let limits = 0;
		let failures = 0;
		for (;;) {
			const remaining = this.deadline - this.deps.now();
			if (remaining <= 0) throw new GitHubDeadline();
			let response: Response | undefined;
			let failure: unknown;
			try {
				response = await this.deps.fetch(url, {
					...(options.body === undefined
						? options.method && { method: options.method }
						: { method: options.method ?? "POST", body: JSON.stringify(options.body) }),
					headers: {
						Accept: accept,
						Authorization: `Bearer ${this.deps.readToken}`,
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "quest",
						...(cached ? { "If-None-Match": cached.etag } : {}),
					},
					...(Number.isFinite(remaining) ? { signal: AbortSignal.timeout(Math.ceil(remaining)) } : {}),
				});
			} catch (error) {
				if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
				failure = error;
			}
			let retry: number | undefined;
			if (response) {
				this.pollInterval = Math.max(this.pollInterval, seconds(response.headers.get("x-poll-interval")) ?? 0);
				// Read the body here, so a connection that drops mid-body is retried like one that drops before it.
				const read = await response.text().then(
					(text) => ({ text }),
					(error: unknown) => ({ error }),
				);
				if (response.status === 304) {
					if (!cached) throw new Error(`unexpected GitHub 304 for ${url.pathname} without a cached response`);
					const headers = new Headers(cached.headers);
					response.headers.forEach((value, name) => headers.set(name, value));
					return new Response(cached.body, { status: 200, statusText: "OK", headers });
				}
				// A rate limit is waited out even when the caller allows its status, such as a 403 refusal.
				if (
					response.ok ||
					(options.allow?.includes(response.status) && !limited(response, "text" in read ? read.text : ""))
				) {
					const { status, statusText, headers } = response;
					const etag = headers.get("etag");
					if (
						"text" in read &&
						key !== undefined &&
						status === 200 &&
						etag &&
						settled(response, url, read.text)
					)
						await this.cached(() => cache!.set(key, { etag, headers: [...headers], body: read.text }));
					if ("text" in read)
						return new Response(NULL_BODY.includes(status) ? null : read.text, {
							status,
							statusText,
							headers,
						});
					if (this.deps.now() >= this.deadline) throw new GitHubDeadline();
					failure = read.error;
				} else {
					// A refusal's status still says what to do when its body was cut off.
					const body = "text" in read ? read.text : "";
					if (limited(response, body)) {
						// GitHub turned the request away unprocessed, so any request repeats.
						await this.waitOut(
							response.headers,
							limits++,
							`GitHub HTTP ${response.status} for ${url.pathname}; rate limit persisted`,
						);
						continue;
					}
					const reason = explanation(body);
					if (response.status < 500)
						throw new Error(
							`GitHub HTTP ${response.status} for ${url.pathname}; ${reason ?? "check repository access and token permissions"}`,
						);
					failure = new Error(
						`GitHub HTTP ${response.status} for ${url.pathname}; ${reason ?? "GitHub server error"}`,
					);
					retry = seconds(response.headers.get("retry-after"));
				}
			}
			if (repeat === false || failures >= TRANSIENT_RETRIES) throw failure;
			const delay = retry ?? backoff(failures);
			failures++;
			this.deps.warn(`${message(failure)}; retrying in ${Math.ceil(delay / 1000)} seconds`);
			await this.pause(delay);
			if (typeof repeat === "function") {
				const landed = await repeat(started);
				if (landed) return landed;
			}
		}
	}

	/**
	 * Run `attempt` again while `transient` names its result a passing GitHub failure, with the bounded
	 * backoff of a failed request, and return its last result.
	 */
	async retry<T>(attempt: () => Promise<T>, transient: (result: T) => string | undefined): Promise<T> {
		for (let failures = 0; ; failures++) {
			const result = await attempt();
			const reason = transient(result);
			if (reason === undefined || failures >= TRANSIENT_RETRIES) return result;
			const delay = backoff(failures);
			this.deps.warn(`${reason}; retrying in ${delay / 1000} seconds`);
			await this.pause(delay);
		}
	}

	/**
	 * Wait out a rate limit, the `limits`th in a row, as its headers say: Retry-After, else the
	 * primary limit's reset, else a minute doubling each time. Fails with `persisted` after six, and
	 * at once on a spent quota unless `quota` says to wait.
	 */
	private async waitOut(headers: Headers, limits: number, persisted: string): Promise<void> {
		if (limits >= 6) throw new Error(persisted);
		const retry = seconds(headers.get("retry-after"));
		const reset =
			headers.get("x-ratelimit-remaining") === "0" ? seconds(headers.get("x-ratelimit-reset")) : undefined;
		if (retry === undefined && reset !== undefined && this.deps.quota === "fail") {
			const minutes = Math.max(1, Math.ceil((reset - this.deps.now()) / 60_000));
			const resource = headers.get("x-ratelimit-resource") ?? "API";
			throw new Error(
				`GitHub's ${resource} rate limit for this token is spent until ${new Date(reset).toISOString()}, ${minutes} minute${minutes === 1 ? "" : "s"} from now`,
			);
		}
		const delay = retry ?? (reset === undefined ? 60_000 * 2 ** limits : Math.max(1000, reset - this.deps.now()));
		this.deps.warn(`GitHub rate limited this request; waiting ${Math.ceil(delay / 1000)} seconds`);
		await this.pause(delay);
	}

	/**
	 * How a request may repeat after a 5xx or a dropped connection. A GET reads and a PUT, PATCH, or
	 * DELETE sets state, so each repeats; so does adding labels. A merge is confirmed first by its
	 * pinned head, and a POST that creates something by what it created: a comment by its body, among
	 * those not already there before it, a pull request by its branch. Any other POST never repeats.
	 */
	private async repeatable(url: URL, options: RequestOptions, started: number): Promise<Repeat> {
		const method = options.method ?? (options.body === undefined ? "GET" : "POST");
		const body = typeof options.body === "object" && options.body !== null ? (options.body as ObjectValue) : {};
		const merge = /^(\/repos\/[^/]+\/[^/]+\/pulls\/\d+)\/merge$/.exec(url.pathname);
		if (method === "PUT" && merge) {
			return async () => {
				const pull = object(await (await this.request(merge[1])).json());
				// Merged at another head is not this merge; repeating it gets GitHub's refusal for the caller.
				if (pull.merged !== true || typeof pull.merge_commit_sha !== "string") return;
				if (body.sha !== undefined && object(pull.head).sha !== body.sha) return;
				return Response.json({
					merged: true,
					sha: pull.merge_commit_sha,
					message: "Pull Request successfully merged",
				});
			};
		}
		if (method !== "POST") return true;
		const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/(labels|comments)$/.exec(url.pathname);
		if (issue?.[1] === "labels") return true;
		if (issue?.[1] === "comments" && typeof body.body === "string") {
			const since = new Date(started - CLOCK_SKEW).toISOString();
			const identical = async () =>
				(await this.all(`${url.pathname}?since=${since}&per_page=100`)).filter(
					(comment) => comment.body === body.body,
				);
			// An identical comment already there, such as one from a requeued PR's earlier ejection, is not this one.
			const earlier = new Set((await identical()).map((comment) => comment.id));
			return async () => {
				const found = (await identical()).find((comment) => !earlier.has(comment.id));
				return found && Response.json(found, { status: 201 });
			};
		}
		const pulls = /^\/repos\/([^/]+)\/[^/]+\/pulls$/.exec(url.pathname);
		if (pulls && typeof body.head === "string") {
			const head = body.head.includes(":") ? body.head : `${pulls[1]}:${body.head}`;
			return async (started) => {
				const open = await this.list(
					`${url.pathname}?state=open&head=${encodeURIComponent(head)}&per_page=100`,
				);
				const found = open.rows.find(
					(pull) =>
						typeof pull.created_at === "string" && Date.parse(pull.created_at) >= started - CLOCK_SKEW,
				);
				return found && Response.json(found, { status: 201 });
			};
		}
		return false;
	}

	/** One page of a REST listing, and its response for the next link. */
	async list(path: string): Promise<{ rows: ObjectValue[]; response: Response }> {
		const response = await this.request(path);
		return { rows: array(await response.json()), response };
	}

	/** Every page of a REST listing. */
	async all(path: string): Promise<ObjectValue[]> {
		const rows: ObjectValue[] = [];
		for (let next: string | undefined = path; next;) {
			const page = await this.list(next);
			rows.push(...page.rows);
			next = link(page.response, "next");
		}
		return rows;
	}

	/**
	 * Run a GraphQL query and return its data, failing on any reported error, and on a mutation, which only
	 * {@link GitHub} runs. A query repeats after a 5xx or a dropped connection. GitHub can report a rate limit as a
	 * 200 whose errors say `RATE_LIMITED`; that is waited out like a REST one.
	 */
	async graphql(query: string, variables: ObjectValue): Promise<ObjectValue> {
		if (mutates(query)) throw new Error("a read-only GitHub client cannot run a mutation");
		return this.operate(query, variables, true);
	}

	/** Run a GraphQL operation that repeats as `repeat` says. */
	protected async operate(query: string, variables: ObjectValue, repeat: Repeat): Promise<ObjectValue> {
		for (let limits = 0; ; limits++) {
			const response = await this.send("/graphql", { body: { query, variables }, repeat });
			const body = object(await response.json());
			if (body.errors === undefined) return object(body.data);
			const errors = array(body.errors);
			if (!errors.some((error) => error.type === "RATE_LIMITED"))
				throw new GitHubGraphQLError(
					errors.map((error) => (typeof error.type === "string" ? error.type : undefined)),
					errors.map((error) => String(error.message)),
				);
			// GitHub turned the operation away unprocessed, so any operation repeats.
			await this.waitOut(response.headers, limits, "GitHub GraphQL rate limit persisted");
		}
	}
}

/** A client that reads and writes on the person's own token, so what it writes is in their name. */
export class GitHub extends GitHubReader {
	constructor(deps: GitHubDependencies, deadline = Infinity) {
		super(reading(deps), deadline);
	}

	/** A request of any method, with {@link GitHubReader.send}'s retries. */
	override request(path: string, options: RequestOptions = {}): Promise<Response> {
		return this.send(path, options);
	}

	/**
	 * Run a GraphQL query, or a mutation: it repeats only once its effect is confirmed missing, and one
	 * confirmed to have taken effect returns no data.
	 */
	override graphql(query: string, variables: ObjectValue): Promise<ObjectValue> {
		return this.operate(query, variables, this.mutationRepeat(query, variables));
	}

	/**
	 * Repeat a query; confirm a pull request mutation `PULL_MUTATIONS` knows; never repeat another.
	 * One pinned to `expectedHeadOid` is confirmed only at that head; at any other, its repeat gets
	 * GitHub's refusal for the caller.
	 */
	private mutationRepeat(query: string, variables: ObjectValue): Repeat {
		if (!mutates(query)) return true;
		const call = /^\s*mutation\b[^{]*\{\s*(\w+)\s*\(\s*input:\s*\{\s*pullRequestId:\s*\$(\w+)\b/.exec(query);
		const effect = call && Object.hasOwn(PULL_MUTATIONS, call[1]) ? PULL_MUTATIONS[call[1]] : undefined;
		const id = call && variables[call[2]];
		if (!effect || typeof id !== "string") return false;
		const pinned = /\bexpectedHeadOid:\s*\$(\w+)\b/.exec(query);
		const head = pinned ? variables[pinned[1]] : undefined;
		const read = `query($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid ${effect.fields} } } }`;
		return async () => {
			const pull = object((await this.graphql(read, { id })).node);
			const landed = (head === undefined || pull.headRefOid === head) && effect.landed(pull);
			return landed ? Response.json({ data: {} }) : undefined;
		};
	}
}

/**
 * Pull request mutations whose effect can be read back: the fields that show it, and whether
 * they do. Each takes its pull request as `pullRequestId`.
 */
const PULL_MUTATIONS: Record<string, { fields: string; landed(pull: ObjectValue): boolean }> = {
	mergePullRequest: { fields: "merged", landed: (pull) => pull.merged === true },
	enqueuePullRequest: {
		fields: "merged mergeQueueEntry { state }",
		landed: (pull) => pull.merged === true || pull.mergeQueueEntry != null,
	},
	enablePullRequestAutoMerge: {
		fields: "merged autoMergeRequest { enabledAt } mergeQueueEntry { state }",
		landed: (pull) => pull.merged === true || pull.autoMergeRequest != null || pull.mergeQueueEntry != null,
	},
	disablePullRequestAutoMerge: {
		fields: "autoMergeRequest { enabledAt }",
		landed: (pull) => pull.autoMergeRequest === null,
	},
	markPullRequestReadyForReview: { fields: "isDraft", landed: (pull) => pull.isDraft === false },
};

/** The cache key of a GET: a hex SHA-256 of the token, media type, and URL, so tokens never share answers. */
async function cacheKey(token: string, accept: string, url: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}\n${accept}\n${url}`));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a 304 can show that an answer is still whole. A 304 carries no Link header and its ETag
 * covers only the body, so a full last page of a listing, whose next page may since have appeared
 * without changing it, is reread whole instead; a page not full changes when anything joins it.
 */
function settled(response: Response, url: URL, body: string): boolean {
	if (link(response, "next")) return true;
	let rows: unknown;
	try {
		rows = JSON.parse(body);
	} catch {
		return true;
	}
	return !Array.isArray(rows) || rows.length < Number(url.searchParams.get("per_page") ?? 30);
}

/** The REST path of a repository. */
export function repositoryPath(repository: Repository): string {
	return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

/** A check a base branch requires. */
export interface RequiredCheck {
	name: string;
	/** The GitHub App whose check run alone satisfies it, or null for any source. */
	app: number | null;
}

/** What a base branch requires, read from branch protection and rulesets. */
export interface Requirements {
	checks: RequiredCheck[];
	/** Workflow files that must pass as a whole, so each of their jobs is required, from {@link workflowKey}. */
	workflows: string[];
	/** Every rule the branch's active rulesets apply: `type`, `parameters`, and the ruleset's source. */
	rules: ObjectValue[];
	/** Whether classic branch protection may be on; its settings beyond required checks need admin rights to read. */
	classic: boolean;
}

/**
 * Every rule a branch's active rulesets apply. GitHub Free offers no rulesets on a private repository and
 * answers 403 with an upgrade notice, so none apply there; any other refusal fails.
 */
async function branchRules(github: GitHubReader, path: string): Promise<ObjectValue[]> {
	const first = await github.request(path, { allow: [403] });
	if (first.status !== 403) {
		const next = link(first, "next");
		return [...array(await first.json()), ...(next ? await github.all(next) : [])];
	}
	const reason = explanation(await first.text());
	if (reason?.startsWith("Upgrade to GitHub Pro")) return [];
	throw new Error(
		`GitHub HTTP 403 for ${new URL(path, API).pathname}; ${reason ?? "check repository access and token permissions"}`,
	);
}

/**
 * A workflow file as requirements name it: its repository's `owner/name` and its path, since a ruleset may
 * require a workflow from another repository at the same path as a local one.
 */
export function workflowKey(repository: string, path: string): string {
	return `${repository.toLowerCase()}:${path}`;
}

/** The workflow files `rules` require, each keyed by {@link workflowKey} from its rule's `repository_id`. */
async function requiredWorkflows(github: GitHubReader, rules: ObjectValue[]): Promise<string[]> {
	const names = new Map<number, string>();
	const keys: string[] = [];
	for (const row of rules
		.filter((rule) => rule.type === "workflows")
		.flatMap((rule) => array(object(rule.parameters).workflows))) {
		const id = Number(row.repository_id);
		if (!names.has(id)) {
			// A repository no token can see is still required; nothing on the head can match its name.
			names.set(id, (await github.repositoryName(id)) ?? `repository ${id}`);
		}
		keys.push(workflowKey(names.get(id)!, string(row.path)));
	}
	return [...new Set(keys)];
}

/** What `branch` of `repository` requires, read with read access from branch protection and rulesets. */
export async function requirements(
	github: GitHubReader,
	repository: Repository,
	branch: string,
): Promise<Requirements> {
	const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
	const ref = encodeURIComponent(branch);
	const protection = object(object(await (await github.request(`${base}/branches/${ref}`)).json()).protection ?? {});
	const legacy = object(protection.required_status_checks ?? {});
	const source = (app: unknown) => (typeof app === "number" && app > 0 ? app : null);
	// Classic protection may list only `contexts`, without the newer `checks`.
	const classic: RequiredCheck[] =
		legacy.enforcement_level === "off"
			? []
			: legacy.checks === undefined
				? (Array.isArray(legacy.contexts) ? legacy.contexts : []).map((name) => ({
						name: string(name),
						app: null,
					}))
				: array(legacy.checks).map((row) => ({ name: string(row.context), app: source(row.app_id) }));
	const rules = await branchRules(github, `${base}/rules/branches/${ref}?per_page=100`);
	const checks = [
		...classic,
		...rules
			.filter((rule) => rule.type === "required_status_checks")
			.flatMap((rule) => array(object(rule.parameters).required_status_checks))
			.map((row) => ({ name: string(row.context), app: source(row.integration_id) })),
	];
	return {
		checks: checks.filter(
			(check, index) =>
				checks.findIndex((other) => other.name === check.name && other.app === check.app) === index,
		),
		workflows: await requiredWorkflows(github, rules),
		rules,
		// Unknown counts as on, so a reader that needs the settings reads them rather than assume none.
		classic: protection.enabled !== false,
	};
}

/** Every GitHub Actions workflow run on `head`. Reading them needs Actions read access. */
export async function workflowRuns(github: GitHubReader, repository: Repository, head: string): Promise<WorkflowRun[]> {
	const runs: WorkflowRun[] = [];
	let path: string | undefined =
		`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/actions/runs?head_sha=${head}&per_page=100`;
	while (path) {
		const response: Response = await github.request(path);
		for (const row of array(object(await response.json()).workflow_runs))
			runs.push({
				...row,
				id: Number(row.id),
				workflow_id: Number(row.workflow_id),
				check_suite_id: Number(row.check_suite_id),
				// A run not yet started, such as one awaiting approval, has no start time, so its creation stands in.
				run_started_at: string(row.run_started_at ?? row.created_at),
			});
		path = link(response, "next");
	}
	return runs;
}

/**
 * Each check's latest report on `head` that still counts, as {@link currentContexts} judges it, and the
 * head's workflow runs when they were read: only when a latest report is a cancelled check run, the only
 * report they can drop.
 */
export async function currentChecks<T extends RollupContext>(
	github: GitHubReader,
	repository: Repository,
	head: string,
	contexts: T[],
): Promise<{ checks: T[]; runs?: WorkflowRun[] }> {
	const latest = latestContexts(contexts);
	if (!latest.some(cancelled)) return { checks: latest };
	const runs = await workflowRuns(github, repository, head);
	return { checks: currentContexts(contexts, runs), runs };
}

/**
 * Whether a merged PR in `repository` had `commit` as its head or below it, as when `quest land` merged
 * the base into the head before squashing; false for a commit GitHub does not have.
 */
export async function mergedHolds(github: GitHubReader, repository: Repository, commit: string): Promise<boolean> {
	const data = await github.graphql(
		"query($owner: String!, $name: String!, $oid: GitObjectID!) { repository(owner: $owner, name: $name) { " +
			"object(oid: $oid) { ... on Commit { associatedPullRequests(first: 100) { nodes { merged headRefOid } } } } } }",
		{ owner: repository.owner, name: repository.repo, oid: commit },
	);
	const found = object(data.repository).object;
	const pulls = found === null || found === undefined ? undefined : object(found).associatedPullRequests;
	if (pulls === null || pulls === undefined) return false; // Unknown, or not a commit.
	for (const pull of array(object(pulls).nodes)) {
		if (pull.merged !== true) continue;
		const head = string(pull.headRefOid);
		if (head === commit) return true;
		// Association alone is no proof the merged head still reaches the commit, such as after a force push.
		// Comparing from the head leaves no commits or files to send when it does.
		const response = await github.request(
			`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/compare/${head}...${commit}`,
			{
				allow: [404],
			},
		);
		if (response.ok && Number(object(await response.json()).ahead_by) === 0) return true;
	}
	return false;
}

/** A login, a committer name without spaces, or `-` for a deleted account. */
export function actor(value: unknown): string {
	if (value === null || value === undefined) return "-";
	const record = object(value);
	return typeof record.login === "string"
		? record.login
		: typeof record.name === "string"
			? record.name.replace(/\s/g, "_")
			: "-";
}

/** `value` as a JSON object, or a thrown invalid-response error. */
export function object(value: unknown): ObjectValue {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("invalid GitHub response: expected an object");
	return value as ObjectValue;
}

/** `value` as an array of JSON objects, or a thrown invalid-response error. */
export function array(value: unknown): ObjectValue[] {
	if (!Array.isArray(value)) throw new Error("invalid GitHub response: expected an array");
	return value.map(object);
}

/** `value` as a nonempty string, or a thrown invalid-response error. */
export function string(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("invalid GitHub response: expected a nonempty string");
	return value;
}

/** The URL a response's `Link` header gives for `relation`, such as the next page. */
export function link(response: Response, relation: string): string | undefined {
	return response.headers
		.get("link")
		?.split(",")
		.map((entry) => /<([^>]+)>;\s*rel="([^"]+)"/.exec(entry.trim()))
		.find((match) => match?.[2] === relation)?.[1];
}

/** GitHub's reason in an error body, such as why it refused to create a pull request. */
function explanation(body: string): string | undefined {
	try {
		const parsed = object(JSON.parse(body));
		const errors = Array.isArray(parsed.errors) ? (parsed.errors as unknown[]) : [];
		const parts = [parsed.message, ...errors.map((error) => (error as ObjectValue | null)?.message)];
		return parts.filter((part): part is string => typeof part === "string" && part !== "").join(": ") || undefined;
	} catch {
		return undefined;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function seconds(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
	const result = Number(value) * 1000;
	return Number.isFinite(result) ? result : undefined;
}
