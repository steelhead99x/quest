// A fake GitHub for the Worker's tests: routes by method and URL, records every
// request, and answers 404 for anything a test did not expect.

import { app, type Env } from "../../src/app.tsx";
import { refreshOnce } from "../../src/auth.ts";
import { GitHub } from "../../src/github/client.ts";
import { type Ledger, rotationName, Rotator } from "../../src/rotation.ts";

export const env: Env = {
	AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
	GITHUB_CLIENT_ID: "Iv23test",
	GITHUB_CLIENT_SECRET: "test-client-secret",
	GITHUB_APP_SLUG: "quest-test",
	SCHEDULE_TIMEZONE: "UTC",
};

export type Route = (request: Request) => Response | Promise<Response> | undefined;

/** A JSON answer. */
export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Coordinators by name, standing in for the Durable Object namespace: one
 * object per refresh token, reached from every location. Pass one to two
 * harnesses to stand for two Cloudflare locations with separate caches.
 */
export class Coordinators {
	readonly objects = new Map<string, Rotator>();
	readonly ledgers = new Map<string, string>();
	/** Make keeping a rotation fail, as a storage write can. */
	failWrites = false;

	get(name: string, perform: ConstructorParameters<typeof Rotator>[2]): Rotator {
		let rotator = this.objects.get(name);
		if (!rotator) {
			const ledger: Ledger = {
				get: async () => this.ledgers.get(name),
				put: async (sealed) => {
					if (this.failWrites) throw new Error("storage write failed");
					this.ledgers.set(name, sealed);
				},
			};
			rotator = new Rotator(ledger, env.AUTH_SECRET, perform);
			this.objects.set(name, rotator);
		}
		return rotator;
	}

	/** Drop every object, as an eviction would, keeping what their storage holds. */
	evict() {
		this.objects.clear();
	}
}

/** The Worker with a fake GitHub and a clock tests can move. */
export function harness(routes: Record<string, Route> = {}, coordinators = new Coordinators()) {
	const requests: Request[] = [];
	let now = Date.UTC(2026, 10, 25, 12);
	// Each harness gets its own cache, so no test sees another's boards.
	const store = caches.open(`test-${crypto.randomUUID()}`);
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		const url = new URL(request.url);
		const route = routes[`${request.method} ${url.origin}${url.pathname}`];
		const answer = route ? await route(request) : undefined;
		return answer ?? json({ message: `unexpected ${request.method} ${request.url}` }, 404);
	};
	const worker = app({
		now: () => now,
		cache: () => store,
		fetch,
		rotate: async (e, s) =>
			coordinators
				.get(await rotationName(s.refresh), (t) =>
					refreshOnce(
						new GitHub(fetch, null),
						{ clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET },
						t,
						now,
					),
				)
				.rotate(s),
	});
	return {
		requests,
		advance: (ms: number) => (now += ms),
		now: () => now,
		/** A request to the Worker, with the cookies given as name=value pairs. */
		request: (path: string, init: RequestInit & { cookies?: string[] } = {}, e: Env = env) => {
			const headers = new Headers(init.headers);
			if (init.cookies?.length) headers.set("cookie", init.cookies.join("; "));
			return worker.request(`https://quest.test${path}`, { ...init, headers, redirect: "manual" }, e);
		},
	};
}

/** The `name=value` of each cookie a response sets, and its attributes. */
export function cookies(response: Response): Map<string, { value: string; attributes: string }> {
	const out = new Map<string, { value: string; attributes: string }>();
	for (const line of response.headers.getSetCookie()) {
		const [pair, ...rest] = line.split("; ");
		const at = pair!.indexOf("=");
		out.set(pair!.slice(0, at), { value: pair!.slice(at + 1), attributes: rest.join("; ") });
	}
	return out;
}

/** GitHub's token answer for a GitHub App with expiring tokens. */
export const issued = (token = "ghu_one", refresh = "ghr_one") => ({
	access_token: token,
	expires_in: 28_800,
	refresh_token: refresh,
	refresh_token_expires_in: 15_897_600,
	token_type: "bearer",
	scope: "",
});
