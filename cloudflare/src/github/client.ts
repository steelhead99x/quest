// GitHub's REST API through one person's token, with a fixed budget of
// requests per page and a cap on what one response may make the Worker hold.
// It also times every request, for the page's Server-Timing header.

/** Requests one page may make: under Workers Free's 50 subrequests, leaving room for the sign-in's own. */
export const BUDGET = 40;
/** The most bytes one GitHub response may hold. */
export const MAX_RESPONSE = 4 * 1024 * 1024;

/** A page ran out of its request budget. */
export class Spent extends Error {
	constructor() {
		super(`this page needs more than ${BUDGET} GitHub requests`);
	}
}

/** GitHub answered with an error status. */
export class GitHubError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		message: string,
	) {
		super(`GitHub answered ${status} for ${path}: ${message}`);
	}
}

/** Fetch, as the Worker's global or a test's fake. */
export type Fetch = (input: Request | string, init?: RequestInit) => Promise<Response>;

/** One page's count of GitHub requests and the time spent waiting on them. */
export interface Meter {
	requests: number;
	/** Milliseconds. */
	time: number;
}

/** One page's GitHub client: its budget, its timing, and the person's token. */
export class GitHub {
	constructor(
		private readonly fetch: Fetch,
		private readonly token: string | null,
		readonly meter: Meter = { requests: 0, time: 0 },
		private readonly budget = BUDGET,
	) {}

	/** The same page's client acting with another token, sharing its budget and timing. */
	withToken(token: string): GitHub {
		return new GitHub(this.fetch, token, this.meter, this.budget);
	}

	/** GET `path` from the REST API and parse its JSON. */
	get<T>(path: string): Promise<T> {
		return this.json<T>("GET", path);
	}

	/** POST `body` to `path`, returning the parsed JSON or null for an empty answer, of at most `max` bytes. */
	post<T>(path: string, body: unknown, max = MAX_RESPONSE): Promise<T> {
		return this.json<T>("POST", path, body, max);
	}

	/** Count and time one request outside the REST API, such as GitHub's OAuth endpoints. */
	async raw(input: string, init: RequestInit): Promise<Response> {
		if (this.meter.requests >= this.budget) throw new Spent();
		this.meter.requests++;
		const start = Date.now();
		try {
			return await this.fetch(input, init);
		} finally {
			this.meter.time += Date.now() - start;
		}
	}

	private async json<T>(method: string, path: string, body?: unknown, max = MAX_RESPONSE): Promise<T> {
		if (!path.startsWith("/")) throw new Error(`a GitHub API path must start with /: ${path}`);
		const response = await this.raw(`https://api.github.com${path}`, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": "quest-cloudflare",
				...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await bounded(response, max);
		if (!response.ok) {
			let message = text.slice(0, 200);
			try {
				message = (JSON.parse(text) as { message?: string }).message ?? message;
			} catch {
				// Not JSON: keep the text.
			}
			throw new GitHubError(response.status, path, message);
		}
		return (text ? JSON.parse(text) : null) as T;
	}
}

/** A response's body as text, refusing one larger than MAX_RESPONSE. */
export async function bounded(response: Response, max = MAX_RESPONSE): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > max) throw new Error(`a GitHub response of ${declared} bytes exceeds ${max}`);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new Error(`a GitHub response exceeded ${max} bytes`);
		}
		chunks.push(value);
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder().decode(all);
}
