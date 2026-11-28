// Which forge answers a repository's reads and takes its writes. A repository Kixel Quest hosts, named by a remote or
// PR URL on Kixel Quest, is read and written there alone. For one on GitHub, reads go to Kixel Quest's index for a
// person holding its token when it serves the repository, else GitHub, and writes go to GitHub. A Kixel Quest failure
// fails the command, naming the setting that reads GitHub instead where that would help. Kixel Quest answers the
// reads that must not lag its index, `pulls`, `files`, and `view`, from GitHub itself, sharing them between callers
// until a webhook touches what they read, so they draw on its installation's rate limit rather than the person's.
import {
	type Answer,
	type ClaimSources,
	type Forge,
	type ForgeCall,
	type ForgeCalls,
	type ForgeInfo,
	type ForgeWrites,
	FORGE_WRITES,
	type Hold,
	type Holdings,
	type OpenPull,
	type Opening,
	type Pick,
	type PullFiles,
	type PullRequest,
	type PullView,
	type Repository,
	type Status,
	type Watch,
	type WatchOptions,
	forgeJson,
	InputError,
	parseForgeAnswer,
	parseForgeInfo,
	Refusal,
} from "../core";
import { type GitHubDependencies, reading } from "../github/client";
import { GitHubForge } from "../github/forge";
import { GitError } from "./git";
import { pullRequest, type RemoteHost, readRemote, remoteHost } from "./github";
import { kixelPath, kixelUrl, notSignedIn, tokenFor, tokensPath } from "./tokens";

/** The variable that, set to `github`, reads GitHub even where Kixel Quest serves the repository. */
export const FORGE = "QUEST_FORGE";

// Worded for one command: agents took `set QUEST_FORGE=github` as a setting for the whole session, and drained the
// GitHub quota they share with every other session on the host.
const REMEDY = `rerun this command with ${FORGE}=github; leave it unset otherwise, since it spends your GitHub quota`;

/** What choosing a forge needs from its host. */
export interface ForgeDependencies {
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	now(): number;
	sleep(milliseconds: number): Promise<unknown>;
	/** Called only once a read goes to GitHub, so Kixel Quest's reads need no GitHub token. */
	github(): GitHubDependencies;
	/** Tells the person something on stderr; a run prints the same line once. */
	warn(line: string): void;
	/** What a Kixel Quest failure tells the person to do; by default, to rerun the command on GitHub. */
	remedy?: string;
}

/** The Kixel Quest `env` names, with the person's token for it; null without a token, or when reads are on GitHub. */
export function kixelQuest(deps: ForgeDependencies): KixelQuest | null {
	const forced = deps.env[FORGE];
	if (forced !== undefined && forced !== "" && forced !== "github")
		throw new Error(`${FORGE} is ${forced}; set it to github to read GitHub, or leave it unset`);
	if (forced === "github") {
		overridden(deps);
		return null;
	}
	const url = kixelUrl(deps.env);
	const token = tokenFor(url, deps.env);
	return token === null ? null : new KixelQuest(url, token, deps, false);
}

/**
 * Warns that the override spends the GitHub quota when a paired token would have read Kixel Quest instead. It costs no
 * request, unlike asking Kixel Quest whether it serves the repository, and a Kixel Quest setting that does not read,
 * which the override exists to get past, skips it.
 */
function overridden(deps: ForgeDependencies): void {
	let url: string;
	try {
		url = kixelUrl(deps.env);
		if (tokenFor(url, deps.env) === null) return;
	} catch {
		return;
	}
	deps.warn(
		`${FORGE}=github spends your GitHub quota on reads Kixel Quest (${url}) may serve; set it only to rerun a command Kixel Quest failed`,
	);
}

/** Kixel Quest's backend for `repository`, which it hosts, failing without the person's token for it. */
export function hostedForge(repository: Repository, deps: ForgeDependencies): KixelQuestForge {
	const name = `${repository.owner}/${repository.repo}`;
	if (deps.env[FORGE] === "github") throw new Error(`Kixel Quest hosts ${name}, so ${FORGE}=github cannot reach it`);
	const url = kixelUrl(deps.env);
	const token = tokenFor(url, deps.env);
	if (token === null) throw new Error(`Kixel Quest hosts ${name}, but ${notSignedIn(url)}`);
	return new KixelQuestForge(new KixelQuest(url, token, deps, true));
}

/**
 * The forge whose answers `repository`'s reads use: Kixel Quest when it hosts the repository, or serves it to this
 * person. Asking Kixel Quest gives up at `deadline`, epoch milliseconds.
 */
export async function forgeFor(
	repository: Repository,
	deps: ForgeDependencies,
	deadline = Infinity,
	hosted = false,
): Promise<Forge> {
	if (hosted) return hostedForge(repository, deps);
	const kixel = kixelQuest(deps);
	return kixel !== null && (await kixel.serves(repository, deadline))
		? new KixelQuestForge(kixel)
		: new GitHubForge(reading(deps.github()));
}

/** Kixel Quest refused the person's token, as a sender must tell from a failure that may pass. */
export class Refused extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** A PR named on the command line, and whether Kixel Quest hosts its repository rather than GitHub. */
export interface Located {
	pull: PullRequest;
	hosted: boolean;
}

/**
 * The PR `value` names: a GitHub PR URL, a Kixel Quest one (`<url>/<owner>/<repo>/pull/<number>`), or a number in
 * the repository the origin remote at `root` names on either.
 */
export function locate(value: string, root: string, env: NodeJS.ProcessEnv): Located {
	const base = kixelUrl(env);
	const path = kixelPath(value, base);
	if (/^[1-9]\d*$/.test(value)) {
		// Outside a checkout, pullRequest says so.
		const host = originHost(root, env);
		if (host?.forge === "kixel") return { pull: { ...host.repository, number: Number(value) }, hosted: true };
	} else if (path !== null) {
		const match = /^([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/.exec(path);
		if (!match) throw new InputError(`expected a Kixel Quest PR URL, ${base}/<owner>/<repo>/pull/<number>`);
		return { pull: { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }, hosted: true };
	}
	return { pull: pullRequest(value, root), hosted: false };
}

/** The forge and repository the origin at `root` names, or null when it names neither or git cannot read `root`. */
export function originHost(root: string, env: NodeJS.ProcessEnv): RemoteHost | null {
	try {
		const origin = readRemote(root, "origin");
		return origin === null ? null : remoteHost(origin, (url) => hostedRepository(kixelUrl(env), url));
	} catch (error) {
		if (error instanceof GitError) return null;
		throw error;
	}
}

/** The repository `value` on Kixel Quest at `base` names, as `<base>/<owner>/<repo>[.git]`, or null. */
export function hostedRepository(base: string, value: string): Repository | null {
	const at = new URL(base);
	const prefix = at.pathname.replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	// Credentials in the URL, as a helper may leave, name the same repository.
	if (url.protocol !== at.protocol || url.host !== at.host || !url.pathname.startsWith(`${prefix}/`)) return null;
	const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname.slice(prefix.length + 1));
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** Kixel Quest's forge API, with a person's token. */
export class KixelQuest {
	#info: Promise<ForgeInfo> | undefined;

	/** `hosted` when it hosts the repository, so reading GitHub instead would not help. */
	constructor(
		readonly url: string,
		private readonly token: string,
		private readonly deps: Omit<ForgeDependencies, "warn">,
		private readonly hosted: boolean,
	) {}

	/** The person the token names, and the repositories Kixel Quest serves them, by `deadline`; kept once read. */
	info(deadline = Infinity): Promise<ForgeInfo> {
		const read = (this.#info ??= this.#send("GET", "/forge", undefined, deadline).then((json) => {
			try {
				return parseForgeInfo(json);
			} catch (error) {
				throw this.#failed("GET", "/forge", (error as Error).message);
			}
		}));
		// A failure, such as a deadline passing, is asked again next time.
		read.catch(() => {
			if (this.#info === read) this.#info = undefined;
		});
		return read;
	}

	/** Whether Kixel Quest answers `repository`'s reads for this person. */
	async serves(repository: Repository, deadline = Infinity): Promise<boolean> {
		return (await this.info(deadline)).repositories.includes(
			`${repository.owner}/${repository.repo}`.toLowerCase(),
		);
	}

	/** The time now, epoch milliseconds. */
	now(): number {
		return this.deps.now();
	}

	/** Ask for `call`, giving up at `deadline` (epoch milliseconds). */
	async call<C extends ForgeCall>(
		call: C,
		request: ForgeCalls[C]["request"],
		deadline = Infinity,
	): Promise<Answer<ForgeCalls[C]["value"]>> {
		const path = `/forge/${call}`;
		const json = await this.#send("POST", path, request, deadline);
		try {
			return parseForgeAnswer(call, json);
		} catch (error) {
			throw this.#failed("POST", path, (error as Error).message);
		}
	}

	/** A failed request, naming the setting that reads GitHub instead where Kixel Quest does not host the repository. */
	#failed(method: string, path: string, why: string): Error {
		const instead = this.hosted ? "" : `; ${this.deps.remedy ?? REMEDY}`;
		return new Error(`Kixel Quest (${this.url}) failed ${method} ${path}: ${why}${instead}`);
	}

	/** The answer to a request, as text; Kixel Quest's refusal of the person's token and any network failure throw. */
	async #fetch(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		deadline: number,
	): Promise<{ response: Response; text: string }> {
		const failed = (why: string) => this.#failed(method, path, why);
		const remaining = deadline - this.deps.now();
		if (remaining <= 0) throw failed("its deadline passed");
		// Called unbound, as a Worker's fetch requires.
		const fetch = this.deps.fetch;
		let response: Response;
		let text: string;
		try {
			response = await fetch(`${this.url}${path}`, {
				method,
				// The token is Kixel Quest's alone, so it follows no redirect elsewhere.
				redirect: "error",
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
					"User-Agent": "quest",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: forgeJson(body) }),
				...(Number.isFinite(remaining)
					? { signal: AbortSignal.timeout(Math.max(0, Math.ceil(remaining))) }
					: {}),
			});
			text = await response.text();
		} catch (error) {
			throw failed(error instanceof Error ? error.message : String(error));
		}
		if (response.status === 401 || response.status === 403)
			throw new Refused(
				failed(`it refused the token ${tokensPath(this.deps.env)} pairs with it (HTTP ${response.status})`)
					.message,
				response.status,
			);
		return { response, text };
	}

	/** The JSON answer to a request, or an error naming the setting that reads GitHub instead. */
	async #send(method: "GET" | "POST", path: string, body: unknown, deadline: number): Promise<unknown> {
		const failed = (why: string) => this.#failed(method, path, why);
		const { response, text } = await this.#fetch(method, path, body, deadline);
		// A malformed wait point, token, thread, or body is the caller's to fix on any forge; the other reads take no
		// free-form argument, so their 400 means the CLI and Kixel Quest disagree on the wire, which reading GitHub
		// sidesteps.
		const write = (FORGE_WRITES as readonly string[]).includes(path.slice("/forge/".length));
		if (response.status === 400 && (path === "/forge/watch" || write))
			throw new InputError(`Kixel Quest refused ${method} ${path}${reason(text) || ", a bad request"}`);
		// A write the forge declines as things stand, such as a PR another session holds, is a refusal to report.
		if (response.status === 409 && write)
			throw new Refusal(reason(text).slice(2) || `Kixel Quest refused ${method} ${path}`);
		// Past the person's budget of GitHub requests, or below the installation's reserve: retrying sooner is refused too.
		if (response.status === 429) {
			const wait = retryAfter(response.headers.get("retry-after"), this.deps.now());
			throw failed(
				`it is rate limiting your requests (HTTP 429${reason(text)})${wait === null ? "" : `; try again in ${wait} second${wait === 1 ? "" : "s"}`}`,
			);
		}
		if (!response.ok) throw failed(`HTTP ${response.status}${reason(text)}`);
		try {
			return JSON.parse(text);
		} catch {
			throw failed("its answer is not JSON");
		}
	}
}

/** The whole seconds a `Retry-After` header, in seconds or an HTTP date, says to wait from `now`; null without one. */
function retryAfter(header: string | null, now: number): number | null {
	if (header === null || header.trim() === "") return null;
	const seconds = /^\d+$/.test(header.trim()) ? Number(header) : (Date.parse(header) - now) / 1000;
	return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null;
}

/** The reason in an error body, `{"error": "..."}`, if it gives one. */
function reason(text: string): string {
	try {
		const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
		return typeof error === "string" && error !== "" ? `, ${error}` : "";
	} catch {
		return "";
	}
}

/** Reads from Kixel Quest's index, and writes to a repository it hosts. */
export class KixelQuestForge implements Forge, ForgeWrites {
	readonly name = "Kixel Quest";

	constructor(private readonly kixel: KixelQuest) {}

	async viewer(): Promise<string> {
		return (await this.kixel.info()).login;
	}

	status(pull: PullRequest): Promise<Answer<Status>> {
		return this.kixel.call("status", { pull });
	}

	pulls(repository: Repository): Promise<Answer<OpenPull[]>> {
		return this.kixel.call("pulls", { repository });
	}

	files(repository: Repository): Promise<Answer<PullFiles[]>> {
		return this.kixel.call("files", { repository });
	}

	held(sources: ClaimSources, branches: string[]): Promise<Answer<Holdings>> {
		return this.kixel.call("held", { sources, branches });
	}

	watch(pull: PullRequest, { since, deadline, started: began }: WatchOptions): Watch {
		const kixel = this.kixel;
		let cursor: string | undefined;
		// Until Kixel Quest first answers, a timeout resumes from when the wait began, so a retry still reports a push
		// made meanwhile; GitHub's backend resumes from the head, which needs a read that could time out too. GitHub
		// times activity to the second, so the point rounds down to keep activity in the wait's first second.
		const started = since ?? new Date(Math.floor((began ?? kixel.now()) / 1000) * 1000).toISOString();
		return {
			get resume() {
				return cursor ?? started;
			},
			async poll() {
				const answer = await kixel.call("watch", { pull, from: cursor ?? since ?? null }, deadline);
				cursor = answer.value.cursor;
				return answer;
			},
		};
	}

	view(pull: PullRequest): Promise<Answer<PullView>> {
		return this.kixel.call("view", { pull });
	}

	async open(opening: Opening): Promise<OpenPull> {
		return (await this.kixel.call("open", { opening })).value;
	}

	async close(pull: PullRequest): Promise<void> {
		await this.kixel.call("close", { pull });
	}

	async edit(pull: PullRequest, { title, body }: { title: string | null; body: string | null }): Promise<void> {
		await this.kixel.call("edit", { pull, title, body });
	}

	async comment(pull: PullRequest, { body, thread }: { body: string; thread: string | null }): Promise<string> {
		return (await this.kixel.call("comment", { pull, body, thread })).value.url;
	}

	async resolve(pull: PullRequest, thread: string): Promise<void> {
		await this.kixel.call("resolve", { pull, thread });
	}

	async hold(pull: PullRequest, token: string | null): Promise<Hold> {
		return (await this.kixel.call("hold", { pull, token })).value;
	}

	async ready(pull: PullRequest, token: string | null): Promise<Hold | null> {
		return (await this.kixel.call("ready", { pull, token })).value;
	}

	async release(pull: PullRequest, token: string): Promise<Hold> {
		return (await this.kixel.call("release", { pull, token })).value;
	}

	/** Kixel Quest's queue fast-forwards the base, so it takes no merge method, and it lands nothing at once. */
	async pick(pull: PullRequest, { head, method, direct }: Pick): Promise<void> {
		if (method !== null || direct)
			throw new InputError(
				`Kixel Quest lands by fast-forwarding the base through its queue, so it takes no --${method ?? "direct"}`,
			);
		await this.kixel.call("pick", { pull, head });
	}
}
