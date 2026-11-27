// A fake Kixel Quest hosting one repository, or serving it from GitHub: its PRs, holds, picks, and review threads in
// memory, served over the forge wire. It parses every request with quest's own wire parsers, so a request the CLI shapes wrongly fails here
// as it would on Kixel Quest, and answers refusals with 409 as Kixel Quest does.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	type Claim,
	type ForgeCall,
	FORGE_CALLS,
	type Hold,
	type OpenPull,
	type PostedReview,
	forgeJson,
	handedBack,
	parseForgeRequest,
	withoutHandBack,
} from "../src/core";
import { tokensPath } from "../src/cli/tokens";

export const KIXEL = "http://localhost:8787";
export const KIXEL_TOKEN = "kq-token";
export const REPOSITORY = { owner: "example", repo: "project" };
export const HEAD = "a".repeat(40);

export interface KixelPull {
	number: number;
	branch: string;
	base: string;
	draft: boolean;
	title: string;
	body: string;
	state: "open" | "closed" | "merged";
	created: number;
	sha: string;
	/** Review threads by ID, and whether each is resolved. */
	threads: Map<string, boolean>;
	comments: { body: string; thread: string | null }[];
	/** Reviews others submitted. */
	reviews: PostedReview[];
	/** The paths it changes. */
	files: string[];
	hold: Hold | null;
	/** The head a pick named, while it stands. */
	picked: string | null;
}

/** The env a CLI run reads: the fake's URL, and a config directory pairing its token with it. */
export function kixelEnv(): Record<string, string> {
	const config = mkdtempSync(join(tmpdir(), "quest-kixel-"));
	writeTokens({ XDG_CONFIG_HOME: config }, { [KIXEL]: KIXEL_TOKEN });
	return { QUEST_KIXEL_URL: KIXEL, XDG_CONFIG_HOME: config };
}

/** Sign the user `env` names in to each Kixel Quest URL with its token, replacing every earlier sign-in. */
export function writeTokens(env: NodeJS.ProcessEnv, tokens: Record<string, string>): void {
	mkdirSync(dirname(tokensPath(env)), { recursive: true });
	const logins = Object.fromEntries(
		Object.entries(tokens).map(([url, token]) => [url, { token, transcripts: false }]),
	);
	writeFileSync(tokensPath(env), JSON.stringify(logins));
}

export class FakeKixelQuest {
	readonly pulls: KixelPull[] = [];
	/** Each call served, by name, with its request. */
	readonly calls: { call: string; request: unknown }[] = [];
	/** Every request's method and path, so a test sees none went anywhere but `/forge`. */
	readonly requests: string[] = [];
	/** The repositories on GitHub `GET /forge` says it serves, whose reads it answers as it does its own. */
	served: string[] = [];
	/** What a call, or every call without `call`, answers instead, such as an outage, with its `Retry-After`. */
	fail: { status: number; error: string; call?: ForgeCall; retryAfter?: string } | undefined;
	#holds = 0;
	#released = new Set<string>();
	#clock = Date.parse("2026-11-17T00:00:00Z");

	/** Open a PR as another person did. */
	add(pull: Partial<KixelPull> & { branch: string }): KixelPull {
		const number = this.pulls.length + 1;
		const added: KixelPull = {
			number,
			base: "main",
			draft: false,
			title: `PR ${number}`,
			body: "",
			state: "open",
			created: this.#clock++,
			sha: HEAD,
			threads: new Map(),
			comments: [],
			reviews: [],
			files: [],
			hold: null,
			picked: null,
			...pull,
		};
		this.pulls.push(added);
		return added;
	}

	url(number: number): string {
		return `${KIXEL}/${REPOSITORY.owner}/${REPOSITORY.repo}/pull/${number}`;
	}

	/** The fetch Kixel Quest answers; any other host is a test failure, since nothing may reach GitHub. */
	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (url.origin !== KIXEL) throw new Error(`unexpected request to ${url.origin}${url.pathname}`);
		this.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (new Headers(init?.headers).get("authorization") !== `Bearer ${KIXEL_TOKEN}`)
			return Response.json({ error: "unknown token" }, { status: 401 });
		if (url.pathname === "/forge") return Response.json({ login: "agent", repositories: this.served });
		const call = /^\/forge\/(\w+)$/.exec(url.pathname)?.[1] as ForgeCall | undefined;
		if (init?.method !== "POST" || call === undefined || !FORGE_CALLS.includes(call))
			return Response.json({ error: "no such call" }, { status: 404 });
		let request: any;
		try {
			request = parseForgeRequest(call, JSON.parse(String(init.body)));
		} catch (error) {
			return Response.json({ error: (error as Error).message }, { status: 400 });
		}
		this.calls.push({ call, request });
		if (this.fail && (this.fail.call ?? call) === call)
			return Response.json(
				{ error: this.fail.error },
				{
					status: this.fail.status,
					headers: this.fail.retryAfter === undefined ? {} : { "retry-after": this.fail.retryAfter },
				},
			);
		try {
			const value = this.#serve(call, request);
			return new Response(forgeJson({ value, asOf: null }), { headers: { "content-type": "application/json" } });
		} catch (error) {
			if (error instanceof Refused) return Response.json({ error: error.message }, { status: 409 });
			throw error;
		}
	};

	#serve(call: ForgeCall, request: any): unknown {
		const repository = request.pull ?? request.repository ?? request.opening?.repository;
		if (repository !== undefined && `${repository.owner}/${repository.repo}` !== "example/project")
			throw new Refused("Kixel Quest does not host that repository");
		const pull = request.pull === undefined ? undefined : this.#pull(request.pull.number);
		switch (call) {
			case "pulls":
				return this.pulls.filter((each) => each.state === "open").map((each) => this.#open(each));
			case "files":
				return this.pulls
					.filter((each) => each.state === "open")
					.map((each) => ({ number: each.number, url: this.url(each.number), files: each.files }));
			case "held": {
				const claims = [...new Set<string>(request.branches)].sort().flatMap((branch): Claim[] => {
					const open = this.pulls.find((each) => each.state === "open" && each.branch === branch);
					if (open) return [{ branch, url: this.url(open.number), pull: this.#open(open) }];
					return request.sources.upstream.tips?.has(branch) ? [{ branch, url: null, pull: null }] : [];
				});
				return { claims, landed: new Map() };
			}
			case "view": {
				const posted = (body: string, index: number) => ({
					author: "agent",
					body,
					createdAt: new Date(pull!.created + index + 1).toISOString(),
					url: `${this.url(pull!.number)}#comment-${index + 1}`,
				});
				const comments = pull!.comments.map((comment, index) => ({
					...comment,
					posted: posted(comment.body, index),
				}));
				return {
					url: this.url(pull!.number),
					title: pull!.title,
					author: "agent",
					state: pull!.state,
					draft: pull!.draft,
					body: pull!.body,
					comments: comments.filter((each) => each.thread === null).map((each) => each.posted),
					reviews: pull!.reviews,
					threads: [...pull!.threads].map(([id, resolved]) => ({
						id,
						path: "src/main.ts",
						line: 1,
						outdated: false,
						resolved,
						comments: comments.filter((each) => each.thread === id).map((each) => each.posted),
					})),
				};
			}
			case "open": {
				const { branch, base, title, body, draft } = request.opening;
				const taken = this.pulls.find((each) => each.state === "open" && each.branch === branch);
				if (taken) throw new Refused(`${this.url(taken.number)} already claims ${branch}`);
				return this.#open(this.add({ branch, base, title, body, draft }));
			}
			case "close":
				pull!.state = "closed";
				return null;
			case "edit":
				if (request.title !== null) pull!.title = request.title;
				if (request.body !== null) pull!.body = request.body;
				return null;
			case "comment":
				if (request.thread !== null) this.#thread(pull!, request.thread);
				pull!.comments.push({ body: request.body, thread: request.thread });
				return { url: `${this.url(pull!.number)}#comment-${pull!.comments.length}` };
			case "resolve":
				this.#thread(pull!, request.thread);
				pull!.threads.set(request.thread, true);
				return null;
			case "hold":
				return this.#hold(pull!, request.token);
			case "ready": {
				if (request.token === null) {
					this.#unheld(pull!);
					pull!.draft = false;
					return null;
				}
				const hold = this.#hold(pull!, request.token);
				pull!.body = withoutHandBack(pull!.body);
				pull!.draft = false;
				return hold;
			}
			case "release": {
				if (pull!.hold?.token === request.token) pull!.hold = null;
				else if (!this.#released.has(request.token))
					throw new Refused(`${request.token} names no hold on ${this.url(pull!.number)}`);
				this.#released.add(request.token);
				return { label: "quest:active", token: request.token };
			}
			case "pick":
				this.#live(pull!);
				if (pull!.sha !== request.head)
					throw new Refused(`${this.url(pull!.number)} head moved to ${pull!.sha}`);
				this.#unheld(pull!);
				pull!.picked = request.head;
				return null;
			default:
				throw new Error(`the fake serves no ${call}`);
		}
	}

	#pull(number: number): KixelPull {
		const pull = this.pulls.find((each) => each.number === number);
		if (!pull) throw new Refused(`no PR ${number}`);
		return pull;
	}

	#open(pull: KixelPull): OpenPull {
		return {
			number: pull.number,
			url: this.url(pull.number),
			branch: pull.branch,
			base: pull.base,
			head: "example/project",
			draft: pull.draft,
			created: pull.created,
			updated: pull.created,
			handedBack: handedBack(pull.body),
			body: pull.body,
		};
	}

	#thread(pull: KixelPull, id: string): void {
		if (!pull.threads.has(id)) throw new Refused(`${id} is not a review thread on ${this.url(pull.number)}`);
	}

	#live(pull: KixelPull): void {
		if (pull.state !== "open") throw new Refused(`${this.url(pull.number)} is ${pull.state}`);
	}

	#unheld(pull: KixelPull): void {
		if (pull.hold !== null) throw new Refused(`${this.url(pull.number)} is held by ${pull.hold.label}`);
	}

	#hold(pull: KixelPull, token: string | null): Hold {
		this.#live(pull);
		if (token !== null) {
			if (pull.hold?.token !== token) throw new Refused(`${token} no longer holds ${this.url(pull.number)}`);
			return pull.hold;
		}
		this.#unheld(pull);
		if (pull.draft && !handedBack(pull.body))
			throw new Refused(`${this.url(pull.number)} is a draft its starter still holds`);
		pull.hold = { label: "quest:active", token: `hold-${++this.#holds}` };
		return pull.hold;
	}
}

class Refused extends Error {}

/**
 * Kixel Quest's `quest login` endpoints, as its Worker answers them: `/login/device` gives a code for a host's label,
 * and `/login/token` answers `authorization_pending` until `approve` runs, then issues the code's token once.
 */
export class FakeLogin {
	/** The label each code was asked for. */
	readonly labels: string[] = [];
	/** How many times a host asked for its token. */
	polls = 0;
	#approved = new Set<string>();
	#issued = 0;

	constructor(
		readonly url = KIXEL,
		readonly code: Partial<Record<"verification_uri" | "expires_in" | "interval", unknown>> = {},
	) {}

	/** Approve every code given so far, as a signed-in person entering it would. */
	approve(): void {
		for (let n = 1; n <= this.labels.length; n++) this.#approved.add(`device-${n}`);
	}

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const body = JSON.parse(String(init?.body)) as Record<string, string>;
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
		if (init?.method !== "POST") return json({ error: "invalid_request" }, 405);
		if (path === "/login/device") {
			if (typeof body.label !== "string" || body.label === "") return json({ error: "invalid_request" }, 400);
			this.labels.push(body.label);
			return json({
				device_code: `device-${this.labels.length}`,
				user_code: "BCDF-GHJK",
				verification_uri: `${this.url}/login`,
				expires_in: 600,
				interval: 5,
				...this.code,
			});
		}
		if (path === "/login/token") {
			this.polls++;
			if (!this.#approved.delete(body.device_code!)) return json({ error: "authorization_pending" }, 400);
			return json({ access_token: `issued-${++this.#issued}`, token_type: "Bearer" });
		}
		return json({ error: "not found" }, 404);
	}) as typeof fetch;
}
