// The service worker's page cache, run against a fake Cache API.

import { readFileSync } from "node:fs";
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
	const self = {
		location: { origin },
		addEventListener: (type: string, handler: (event: FetchEvent) => void) => handlers.set(type, handler),
	};
	const caches = { open: async () => pages, match: async () => undefined, keys: async () => [] };
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
	return { visit, kept };
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
