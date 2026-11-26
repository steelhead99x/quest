import { type Context as HonoContext, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { authorizeUrl, type Config, exchange, refreshed, revoke } from "./auth.ts";
import { CALLBACK } from "./github/app.ts";
import { type Fetch, GitHub, GitHubError, Spent } from "./github/client.ts";
import { repositories } from "./github/repos.ts";
import { load, NotFound, type Tree } from "./board/load.ts";
import { board, lookup } from "./board/model.ts";
import { BoardPage, QuestPage } from "./board/pages.tsx";
import { cached } from "./cache.ts";
import { Home, Message } from "./home.tsx";
import type { User } from "./layout.tsx";
import { local, open, pending, SESSION, type Session, STATE, seal, session } from "./session.ts";

/** What the Worker reads from its environment: secrets and one var. */
export interface Env {
	AUTH_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_APP_SLUG: string;
}

/** What the app takes from outside, so tests can fake GitHub and the clock. */
export interface Deps {
	fetch: Fetch;
	now: () => number;
	/** Where GitHub answers are cached briefly, or null for none. */
	cache: () => Promise<Cache | null>;
}

type Vars = { github: GitHub; session: Session | null; config: Config; install: string; cookies: string[] };
type Bindings = { Bindings: Env; Variables: Vars };
type App = Hono<Bindings>;
// Any route's context, for the helpers below.
type Context = HonoContext<Bindings, any, any>;

/** How long a person has to finish signing in on GitHub. */
const SIGN_IN_WINDOW = 10 * 60_000;

/** The deploy's misconfiguration, reported on every page rather than half-working. */
class Misconfigured extends Error {}

/** Check the environment, naming every missing setting at once. */
export function configure(env: Env, origin: string): { config: Config; install: string } {
	const missing = (["AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_SLUG"] as const).filter(
		(k) => !env[k],
	);
	if (missing.length) throw new Misconfigured(`this deploy is missing ${missing.join(", ")}`);
	if (env.AUTH_SECRET.length < 32) throw new Misconfigured("AUTH_SECRET must be at least 32 characters");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(env.GITHUB_APP_SLUG))
		throw new Misconfigured("GITHUB_APP_SLUG is not an App slug");
	return {
		config: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, origin },
		install: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
	};
}

/** A Set-Cookie header for one of the site's `__Host-` cookies; null clears it. */
export function cookie(name: string, value: string | null, maxAge: number): string {
	return `${name}=${value ?? ""}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${value === null ? 0 : Math.max(0, Math.floor(maxAge))}`;
}

/** The site's content security policy: its own scripts only, the theme's fonts, and GitHub for sign-in. */
export const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' https://fonts.googleapis.com",
	"font-src https://fonts.gstatic.com",
	"img-src 'self' data: https://avatars.githubusercontent.com",
	"connect-src 'self'",
	"form-action 'self' https://github.com",
	"frame-ancestors 'none'",
	"base-uri 'none'",
].join("; ");

/** The Worker's routes. */
export function app(deps: Deps): App {
	const web: App = new Hono();

	web.use(async (c, next) => {
		const start = deps.now();
		const origin = new URL(c.req.url).origin;
		c.set("cookies", []);
		c.set("github", new GitHub(deps.fetch, null));
		const { config, install } = configure(c.env, origin);
		c.set("config", config);
		c.set("install", install);
		await loadSession(c, deps);
		await next();
		const github = c.get("github").meter;
		const total = deps.now() - start;
		// The two durations add up to the Worker's time, so a reader summing them counts each millisecond once.
		c.header(
			"Server-Timing",
			`app;dur=${Math.max(0, total - github.time)}, github;dur=${github.time};desc="${github.requests} requests"`,
		);
		c.header("Content-Security-Policy", CSP);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "same-origin");
		if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-cache");
		for (const set of c.get("cookies")) c.header("Set-Cookie", set, { append: true });
	});

	web.get("/", async (c) => {
		const s = c.get("session");
		const repos = s ? await repositories(c.get("github").withToken(s.token)) : null;
		return c.html(<Home user={user(s)} install={c.get("install")} repos={repos} />);
	});

	web.get("/repos/:owner/:name", async (c) => {
		const b = await boardFor(c, deps);
		if (b instanceof Response) return b;
		return c.html(<BoardPage b={b} user={user(c.get("session"))!} path={new URL(c.req.url).pathname} />);
	});

	web.get("/repos/:owner/:name/*", async (c) => {
		const b = await boardFor(c, deps);
		if (b instanceof Response) return b;
		const prefix = `/repos/${c.req.param("owner")}/${c.req.param("name")}/`;
		const page = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
		const doc = lookup(b, page);
		if (!doc) return page404(c);
		return c.html(
			<QuestPage
				b={b}
				doc={doc.path}
				user={user(c.get("session"))!}
				path={new URL(c.req.url).pathname}
				now={deps.now()}
			/>,
		);
	});

	web.get("/sign-in", async (c) => {
		const state = crypto.randomUUID();
		const next = local(c.req.query("next"));
		const sealed = await seal(c.env.AUTH_SECRET, "state", { state, next, expires: deps.now() + SIGN_IN_WINDOW });
		c.get("cookies").push(cookie(STATE, sealed, SIGN_IN_WINDOW / 1000));
		return c.redirect(authorizeUrl(c.get("config"), state), 302);
	});

	web.get(CALLBACK, async (c) => {
		const was = pending(await open(c.env.AUTH_SECRET, "state", getCookie(c, STATE)), deps.now());
		c.get("cookies").push(cookie(STATE, null, 0));
		if (c.req.query("error"))
			return page(
				c,
				400,
				"Sign-in cancelled",
				`GitHub said: ${c.req.query("error_description") ?? c.req.query("error")}`,
			);
		const code = c.req.query("code");
		if (!was || !code || c.req.query("state") !== was.state)
			return page(
				c,
				400,
				"Sign-in expired",
				"That sign-in link is stale or was not started here. Sign in again.",
			);
		const s = await exchange(c.get("github"), c.get("config"), code, deps.now());
		await setSession(c, s, deps);
		return c.redirect(was.next, 302);
	});

	web.post("/sign-out", async (c) => {
		const refused = sameOrigin(c.req.raw);
		if (refused) return page(c, 403, "Refused", refused);
		const s = c.get("session");
		c.get("cookies").push(cookie(SESSION, null, 0));
		c.set("session", null);
		// Drop the cached pages the service worker kept for this person.
		c.header("Clear-Site-Data", '"cache", "storage"');
		if (s) await revoke(c.get("github"), c.get("config"), s.token);
		return c.redirect("/", 303);
	});

	web.notFound((c) => page404(c));

	web.onError((error, c) => {
		if (error instanceof Spent)
			return page(c, 503, "Too much to show", `${error.message}; this page lists less than it would need.`);
		if (error instanceof GitHubError && error.status === 401) {
			c.get("cookies")?.push(cookie(SESSION, null, 0));
			return page(c, 401, "Signed out", "GitHub no longer accepts your sign-in. Sign in again.");
		}
		if (error instanceof Misconfigured) return c.text(error.message, 500);
		if (error instanceof NotFound)
			return page(
				c,
				404,
				"Repository not found",
				`${error.message} does not exist, or you cannot read it, or the App is not installed on it.`,
			);
		console.error(error);
		return page(c, 500, "Something broke", error.message);
	});

	return web;
}

function user(s: Session | null): User | null {
	return s ? { login: s.login } : null;
}

function page(c: Context, status: number, title: string, text: string) {
	return c.html(
		<Message user={user(c.get("session") ?? null)} path={new URL(c.req.url).pathname} title={title}>
			{text}
		</Message>,
		status as 400,
	);
}

function page404(c: Context) {
	return page(c, 404, "Not found", "There is no page here.");
}

/** A repository name GitHub would accept, so a path cannot smuggle anything into the query. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The board for the route's repository, or a response sending the person to sign in. */
async function boardFor(c: Context, deps: Deps) {
	const s = c.get("session");
	const owner = c.req.param("owner") ?? "";
	const name = c.req.param("name") ?? "";
	if (!NAME.test(owner) || !NAME.test(name)) return page404(c);
	if (!s) return c.redirect(`/sign-in?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
	const github = c.get("github").withToken(s.token);
	const key = `board ${s.id} ${owner}/${name}`.toLowerCase();
	const tree = await cached<Tree>(await deps.cache(), key, () => load(github, owner, name));
	return board(tree, deps.now());
}

/** Refuse a form post from another site, or from a browser that hides where it came from. */
export function sameOrigin(request: Request): string | null {
	const origin = request.headers.get("origin");
	if (!origin) return "This form must be sent from the site itself.";
	return origin === new URL(request.url).origin ? null : "This form was sent from another site.";
}

async function loadSession(c: Context, deps: Deps) {
	const raw = getCookie(c, SESSION);
	const was = session(await open(c.env.AUTH_SECRET, "session", raw));
	if (!was) {
		if (raw) c.get("cookies").push(cookie(SESSION, null, 0));
		c.set("session", null);
		return;
	}
	const now = await refreshed(c.get("github"), c.get("config"), was, deps.now());
	if (!now) {
		c.get("cookies").push(cookie(SESSION, null, 0));
		c.set("session", null);
		return;
	}
	if (now !== was) await setSession(c, now, deps);
	else c.set("session", now);
}

async function setSession(c: Context, s: Session, deps: Deps) {
	c.set("session", s);
	const sealed = await seal(c.env.AUTH_SECRET, "session", s);
	c.get("cookies").push(cookie(SESSION, sealed, (s.refreshExpires - deps.now()) / 1000));
}
