// The service worker's page cache, run against a fake Cache API.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

type Req = { url: string; method: string; mode: string };
type FetchEvent = { request: Req; respondWith(p: Promise<unknown>): void; waitUntil(p: Promise<unknown>): void };

/**
 * A cache that lists entries in insertion order and, like some browsers, leaves an
 * existing entry where it is when `put` replaces it.
 */
class FakeCache {
	readonly entries: { url: string; response: Response }[] = [];
	async put(request: Req, response: Response) {
		const at = this.entries.find((e) => e.url === request.url);
		if (at) at.response = response;
		else this.entries.push({ url: request.url, response });
	}
	async delete(request: Req) {
		const i = this.entries.findIndex((e) => e.url === request.url);
		if (i >= 0) this.entries.splice(i, 1);
		return i >= 0;
	}
	async keys() {
		return this.entries.map((e) => ({ url: e.url }) as Req);
	}
	async match(request: Req) {
		return this.entries.find((e) => e.url === request.url)?.response;
	}
}

function worker(control = "public, max-age=60") {
	const origin = "https://quest.example";
	const handlers = new Map<string, (event: FetchEvent) => void>();
	const pages = new FakeCache();
	const precached: string[] = [];
	const self = {
		location: { origin },
		addEventListener: (type: string, handler: (event: FetchEvent) => void) => handlers.set(type, handler),
		skipWaiting: async () => undefined,
	};
	const shell = { addAll: async (paths: string[]) => void precached.push(...paths) };
	const caches = {
		open: async (name: string) => (name.startsWith("shell-") ? shell : pages),
		match: async () => undefined,
		keys: async () => [],
	};
	const fetch = async () => new Response("<html>", { headers: { "cache-control": control } });
	const source = readFileSync(join(import.meta.dirname, "..", "src", "sw.js"), "utf8");
	new Function("self", "caches", "fetch", source)(self, caches, fetch);
	/** Navigate to `path` and wait until its copy is kept. */
	const visit = async (path: string) => {
		const pending: Promise<unknown>[] = [];
		handlers.get("fetch")!({
			request: { url: `${origin}${path}`, method: "GET", mode: "navigate" },
			respondWith: (p) => pending.push(p),
			waitUntil: (p) => pending.push(p),
		});
		// respondWith comes first; the copy is kept in a waitUntil it registers.
		await pending[0];
		await Promise.all(pending);
	};
	const kept = () => pages.entries.map((e) => new URL(e.url).pathname);
	/** Run the install handler and return what it precached. */
	const install = async () => {
		let done: Promise<unknown> = Promise.resolve();
		(handlers.get("install") as unknown as (e: { waitUntil(p: Promise<unknown>): void }) => void)({
			waitUntil: (p) => (done = p),
		});
		await done;
		return precached;
	};
	return { visit, kept, install };
}

test("a refreshed page counts as newest, so trimming to the limit drops the oldest", async () => {
	const { visit, kept } = worker();
	for (let i = 1; i <= 30; i++) await visit(`/p${i}`);
	expect(kept()).toHaveLength(30);
	await visit("/p1");
	await visit("/p31");
	expect(kept()).toHaveLength(30);
	expect(kept()).toContain("/p1");
	expect(kept()).not.toContain("/p2");
	expect(kept().at(-1)).toBe("/p31");
});

test("never keeps a page rendered for a signed-in person, or a sign-in step", async () => {
	const signedIn = worker("private, no-store");
	await signedIn.visit("/repos/o/r");
	expect(signedIn.kept()).toEqual([]);
	const pub = worker();
	await pub.visit("/sign-in");
	await pub.visit("/auth/callback");
	expect(pub.kept()).toEqual([]);
});

test("install precaches the shell and the offline notice, never the link-preview image", async () => {
	const paths = await worker().install();
	expect(paths).toContain("/offline");
	expect(paths).toContain("/site.css");
	expect(paths).not.toContain("/og.png");
	// Every precached path is a file the build serves, so install can't fail on a 404.
	for (const path of paths) expect(path).toMatch(/^\/[\w./-]+$/);
	const built = join(import.meta.dirname, "..", "build", "public");
	for (const path of paths.filter((p) => p !== "/offline")) expect(existsSync(join(built, path)), path).toBe(true);
});

test("the manifest names Kixel Quest and every icon it lists is built; unused theme files are not", () => {
	const built = join(import.meta.dirname, "..", "build", "public");
	const manifest = JSON.parse(readFileSync(join(built, "manifest.webmanifest"), "utf8"));
	expect(manifest.name).toBe("Kixel Quest");
	expect(manifest.icons.length).toBeGreaterThan(0);
	for (const icon of manifest.icons) expect(existsSync(join(built, icon.src)), icon.src).toBe(true);
	expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
	expect(existsSync(join(built, "theme", "theme.css"))).toBe(true);
	for (const gone of ["theme/moq-dev-wordmark.svg", "theme/logo.svg", "brand/README.md", "brand/og.svg"])
		expect(existsSync(join(built, gone)), gone).toBe(false);
});
