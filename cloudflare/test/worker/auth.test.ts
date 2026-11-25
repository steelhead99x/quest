import { describe, expect, test } from "vitest";
import { tokens } from "../../src/auth.ts";
import { bounded, GitHub, Spent } from "../../src/github/client.ts";
import { local, open, seal, SESSION, STATE } from "../../src/session.ts";
import { cookies, env, harness, issued, json, type Route } from "./fake.ts";

const TOKEN = "POST https://github.com/login/oauth/access_token";
const USER = "GET https://api.github.com/user";
const INSTALLATIONS = "GET https://api.github.com/user/installations";

const signedInRoutes: Record<string, Route> = {
	[TOKEN]: () => json(issued()),
	[USER]: () => json({ id: 7, login: "octo" }),
	[INSTALLATIONS]: () => json({ total_count: 1, installations: [{ id: 99, account: { login: "moq-dev" } }] }),
	"GET https://api.github.com/user/installations/99/repositories": () =>
		json({
			total_count: 2,
			repositories: [
				{ name: "quest", private: false, owner: { login: "moq-dev" } },
				{ name: "moq", private: true, owner: { login: "moq-dev" } },
			],
		}),
};

/** Sign in through the real routes, returning the session cookie. */
async function signIn(h: ReturnType<typeof harness>, next = "/") {
	const start = await h.request(`/sign-in?next=${encodeURIComponent(next)}`);
	const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
	const stateCookie = cookies(start).get(STATE)!.value;
	const back = await h.request(`/auth/callback?code=abc&state=${state}`, { cookies: [`${STATE}=${stateCookie}`] });
	return { back, session: cookies(back).get(SESSION) };
}

describe("signed out", () => {
	test("the home page offers sign-in and the App install, with the site's headers", async () => {
		const h = harness();
		const response = await h.request("/");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Sign in with GitHub");
		expect(html).toContain("https://github.com/apps/quest-test/installations/new");
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
		expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(response.headers.get("server-timing")).toMatch(/^app;dur=\d+, github;dur=0;desc="0 requests"$/);
		expect(h.requests).toEqual([]);
	});

	test("a deploy missing settings says which, on every page", async () => {
		const h = harness();
		const response = await h.request("/", {}, { ...env, GITHUB_CLIENT_SECRET: "", GITHUB_APP_SLUG: "" });
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("this deploy is missing GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG");
	});

	test("an unknown path is a themed 404", async () => {
		const response = await harness().request("/nowhere");
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("There is no page here.");
	});
});

describe("sign-in", () => {
	test("sends the person to GitHub with a state bound to a sealed cookie", async () => {
		const h = harness();
		const response = await h.request("/sign-in?next=%2Frepos%2Fmoq-dev%2Fquest");
		expect(response.status).toBe(302);
		const to = new URL(response.headers.get("location")!);
		expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(to.searchParams.get("client_id")).toBe("Iv23test");
		expect(to.searchParams.get("redirect_uri")).toBe("https://quest.test/auth/callback");
		const state = cookies(response).get(STATE)!;
		expect(state.attributes).toBe("Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
		const opened = (await open(env.AUTH_SECRET, "state", state.value)) as { state: string; next: string };
		expect(opened.state).toBe(to.searchParams.get("state"));
		expect(opened.next).toBe("/repos/moq-dev/quest");
	});

	test("exchanges the code, sets the session, and returns where the person was", async () => {
		const h = harness(signedInRoutes);
		const { back, session } = await signIn(h, "/repos/moq-dev/quest");
		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe("/repos/moq-dev/quest");
		expect(cookies(back).get(STATE)!.attributes).toContain("Max-Age=0");
		expect(session!.attributes).toBe("Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15897600");
		const exchange = h.requests.find((r) => r.url === "https://github.com/login/oauth/access_token")!;
		const form = new URLSearchParams(await exchange.text());
		expect(Object.fromEntries(form)).toEqual({
			client_id: "Iv23test",
			client_secret: "test-client-secret",
			code: "abc",
			redirect_uri: "https://quest.test/auth/callback",
		});
		const user = h.requests.find((r) => r.url === "https://api.github.com/user")!;
		expect(user.headers.get("authorization")).toBe("Bearer ghu_one");
	});

	test("returns only to a path on this site", async () => {
		for (const next of ["//evil.example/x", "https://evil.example/", "/\\evil.example"]) {
			const { back } = await signIn(harness(signedInRoutes), next);
			expect(back.headers.get("location")).toBe("/");
		}
	});

	test.each([
		["a state that does not match", (s: string) => `/auth/callback?code=abc&state=${s}x`],
		["no code", (s: string) => `/auth/callback?state=${s}`],
	])("refuses %s", async (_, path) => {
		const h = harness(signedInRoutes);
		const start = await h.request("/sign-in");
		const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
		const response = await h.request(path(state), { cookies: [`${STATE}=${cookies(start).get(STATE)!.value}`] });
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Sign-in expired");
		expect(h.requests).toEqual([]);
	});

	test("refuses a sign-in finished after its window", async () => {
		const h = harness(signedInRoutes);
		const start = await h.request("/sign-in");
		const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
		h.advance(11 * 60_000);
		const response = await h.request(`/auth/callback?code=abc&state=${state}`, {
			cookies: [`${STATE}=${cookies(start).get(STATE)!.value}`],
		});
		expect(response.status).toBe(400);
	});

	test("says so when the person cancels on GitHub", async () => {
		const response = await harness().request(
			"/auth/callback?error=access_denied&error_description=The+user+denied",
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("GitHub said: The user denied");
	});

	test("explains an App without expiring tokens", () => {
		expect(() => tokens({ access_token: "gho_x", token_type: "bearer" }, 0)).toThrow("expiring user tokens");
		expect(() => tokens({ error: "bad_verification_code", error_description: "The code is wrong" }, 0)).toThrow(
			"The code is wrong",
		);
	});
});

describe("signed in", () => {
	test("lists the repositories the App can reach, with GitHub's time in Server-Timing", async () => {
		const h = harness(signedInRoutes);
		const { session } = await signIn(h);
		const before = h.requests.length;
		const response = await h.request("/", { cookies: [`${SESSION}=${session!.value}`] });
		const html = await response.text();
		expect(html).toContain('<span class="muted">octo</span>');
		expect(html).toContain('href="/repos/moq-dev/moq"');
		expect(html.indexOf(">moq</a>")).toBeLessThan(html.indexOf(">quest</a>"));
		expect(html).toContain("Private");
		expect(h.requests.length - before).toBe(2);
		expect(response.headers.get("server-timing")).toMatch(/github;dur=\d+;desc="2 requests"/);
		expect(response.headers.get("cache-control")).toBe("private, no-cache");
	});

	test("refreshes an expiring token and reissues the cookie", async () => {
		const h = harness({ ...signedInRoutes });
		const { session } = await signIn(h);
		h.advance(8 * 3_600_000);
		let refreshedWith = "";
		const routes = harness({
			...signedInRoutes,
			[TOKEN]: async (r) => {
				refreshedWith = new URLSearchParams(await r.text()).get("refresh_token") ?? "";
				return json(issued("ghu_two", "ghr_two"));
			},
		});
		routes.advance(8 * 3_600_000);
		const response = await routes.request("/", { cookies: [`${SESSION}=${session!.value}`] });
		expect(response.status).toBe(200);
		expect(refreshedWith).toBe("ghr_one");
		const renewed = cookies(response).get(SESSION)!;
		const opened = (await open(env.AUTH_SECRET, "session", renewed.value)) as { token: string };
		expect(opened.token).toBe("ghu_two");
		const listed = routes.requests.find((r) => r.url.includes("/user/installations?"))!;
		expect(listed.headers.get("authorization")).toBe("Bearer ghu_two");
	});

	test("signs out when the refresh token is refused", async () => {
		const h = harness(signedInRoutes);
		const { session } = await signIn(h);
		const later = harness({ [TOKEN]: () => json({ error: "bad_refresh_token" }) });
		later.advance(9 * 3_600_000);
		const response = await later.request("/", { cookies: [`${SESSION}=${session!.value}`] });
		expect(await response.text()).toContain("Sign in with GitHub");
		expect(cookies(response).get(SESSION)!.attributes).toContain("Max-Age=0");
	});

	test("treats a tampered or foreign cookie as signed out and clears it", async () => {
		const forged = await seal("another-secret-that-is-at-least-32-characters", "session", {
			id: 1,
			login: "mallory",
			token: "t",
			expires: Date.UTC(2030, 0),
			refresh: "r",
			refreshExpires: Date.UTC(2030, 0),
		});
		const h = harness();
		for (const value of [forged, forged.slice(0, -2) + "AA", "garbage"]) {
			const response = await h.request("/", { cookies: [`${SESSION}=${value}`] });
			expect(await response.text()).toContain("Sign in with GitHub");
			expect(cookies(response).get(SESSION)!.attributes).toContain("Max-Age=0");
		}
		expect(h.requests).toEqual([]);
	});

	test("signs out when GitHub stops accepting the token", async () => {
		const h = harness(signedInRoutes);
		const { session } = await signIn(h);
		const revoked = harness({ [INSTALLATIONS]: () => json({ message: "Bad credentials" }, 401) });
		const response = await revoked.request("/", { cookies: [`${SESSION}=${session!.value}`] });
		expect(response.status).toBe(401);
		expect(cookies(response).get(SESSION)!.attributes).toContain("Max-Age=0");
	});

	test("says so rather than half-listing when a page runs out of GitHub requests", async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, account: { login: `org${i}` } }));
		const routes: Record<string, Route> = {
			...signedInRoutes,
			[INSTALLATIONS]: () => json({ total_count: 10, installations: many }),
		};
		for (let i = 1; i <= 10; i++)
			routes[`GET https://api.github.com/user/installations/${i}/repositories`] = () =>
				json({ total_count: 0, repositories: [] });
		const h = harness(routes);
		const { session } = await signIn(h);
		// The budget is per page: 40 requests, and this page needs 11, so it fits.
		expect((await h.request("/", { cookies: [`${SESSION}=${session!.value}`] })).status).toBe(200);
		const tight = new GitHub(async () => json({}), "t", undefined, 1);
		await tight.get("/a");
		await expect(tight.get("/b")).rejects.toBeInstanceOf(Spent);
	});
});

describe("sign-out", () => {
	test("refuses a post without this site's origin", async () => {
		const h = harness(signedInRoutes);
		const { session } = await signIn(h);
		for (const headers of [{}, { origin: "https://evil.example" }] as Record<string, string>[]) {
			const response = await h.request("/sign-out", {
				method: "POST",
				headers,
				cookies: [`${SESSION}=${session!.value}`],
			});
			expect(response.status).toBe(403);
		}
	});

	test("clears the cookie and cached pages, and revokes the token", async () => {
		let revoked: Request | null = null;
		const h = harness({
			...signedInRoutes,
			"DELETE https://api.github.com/applications/Iv23test/token": (r) => (
				(revoked = r),
				new Response(null, { status: 204 })
			),
		});
		const { session } = await signIn(h);
		const response = await h.request("/sign-out", {
			method: "POST",
			headers: { origin: "https://quest.test" },
			cookies: [`${SESSION}=${session!.value}`],
		});
		expect(response.status).toBe(303);
		expect(response.headers.get("clear-site-data")).toBe('"cache", "storage"');
		expect(cookies(response).get(SESSION)!.attributes).toContain("Max-Age=0");
		expect(revoked!.headers.get("authorization")).toBe(`Basic ${btoa("Iv23test:test-client-secret")}`);
		expect(await revoked!.json()).toEqual({ access_token: "ghu_one" });
	});
});

describe("helpers", () => {
	test("local keeps only paths on this site", () => {
		expect(local("/repos/a/b?x=1")).toBe("/repos/a/b?x=1");
		for (const bad of [null, "", "repos", "//x", "/\\x", "https://x", "/" + "a".repeat(600)])
			expect(local(bad)).toBe("/");
	});

	test("bounded refuses an oversized body whether declared or streamed", async () => {
		await expect(bounded(new Response("x".repeat(10), { headers: { "content-length": "10" } }), 5)).rejects.toThrow(
			"exceeds 5",
		);
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode("abc"));
				c.enqueue(new TextEncoder().encode("def"));
				c.close();
			},
		});
		await expect(bounded(new Response(stream), 5)).rejects.toThrow("exceeded 5");
		expect(await bounded(new Response("abc"), 5)).toBe("abc");
	});
});
