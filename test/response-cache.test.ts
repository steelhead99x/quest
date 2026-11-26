import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { diskResponseCache } from "../src/cli/response-cache";
import { type CachedResponse, GitHub, type ResponseCache } from "../src/github/client";

const repo = "/repos/example/project";
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
	const made = mkdtempSync(join(tmpdir(), "quest-response-cache-"));
	directories.push(made);
	return join(made, "github");
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers });
}

const notModified = (headers: Record<string, string> = {}) => new Response(null, { status: 304, headers });

/** A client for `token` answering from `replies`, recording each request's If-None-Match. */
function client(cache: ResponseCache, replies: Response[], token = "token") {
	const sent: (string | null)[] = [];
	const github = new GitHub({
		token,
		quota: "fail",
		now: () => 0,
		sleep: async () => {},
		warn: () => {},
		cache,
		fetch: (async (_input, init) => {
			sent.push(new Headers(init?.headers).get("If-None-Match"));
			const reply = replies.shift();
			if (!reply) throw new Error("unexpected request");
			return reply;
		}) as typeof fetch,
	});
	return { github, sent };
}

describe("ETag revalidation", () => {
	test("a second identical GET sends If-None-Match and serves the cached body on 304", async () => {
		const cache = diskResponseCache(directory());
		const first = client(cache, [json({ id: 1 }, { etag: '"a"', link: '<x>; rel="last"' })]);
		expect(await (await first.github.request(`${repo}/pulls/1`)).json()).toEqual({ id: 1 });
		expect(first.sent).toEqual([null]);

		// A new process: only the disk carries the answer over.
		const second = client(diskResponseCache(join(directories[0], "github")), [
			notModified({ etag: '"a"', "x-ratelimit-remaining": "4999" }),
		]);
		const response = await second.github.request(`${repo}/pulls/1`);
		expect(second.sent).toEqual(['"a"']);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: 1 });
		// The 304's own headers win; the ones it omits, such as Link, come from the cached answer.
		expect(response.headers.get("x-ratelimit-remaining")).toBe("4999");
		expect(response.headers.get("link")).toBe('<x>; rel="last"');
	});

	test("a changed answer replaces the cached one", async () => {
		const cache = diskResponseCache(directory());
		const { github, sent } = client(cache, [
			json({ v: 1 }, { etag: '"1"' }),
			json({ v: 2 }, { etag: '"2"' }),
			notModified(),
		]);
		await github.request(`${repo}/pulls/1`);
		await github.request(`${repo}/pulls/1`);
		expect(await (await github.request(`${repo}/pulls/1`)).json()).toEqual({ v: 2 });
		expect(sent).toEqual([null, '"1"', '"2"']);
	});

	test("a different token never reads another's entry", async () => {
		const cache = diskResponseCache(directory());
		await client(cache, [json({ secret: true }, { etag: '"s"' })], "alice").github.request(`${repo}/pulls/1`);
		const bob = client(cache, [json({ secret: false }, { etag: '"t"' })], "bob");
		expect(await (await bob.github.request(`${repo}/pulls/1`)).json()).toEqual({ secret: false });
		expect(bob.sent).toEqual([null]);
		// No token reaches the disk.
		for (const name of readdirSync(join(directories[0], "github")))
			expect(readFileSync(join(directories[0], "github", name), "utf8")).not.toMatch(/alice|bob/);
	});

	test("a different media type is its own entry", async () => {
		const cache = diskResponseCache(directory());
		const { github, sent } = client(cache, [
			json({}, { etag: '"j"' }),
			new Response("diff", { headers: { etag: '"d"' } }),
		]);
		await github.request(`${repo}/pulls/1`);
		await github.request(`${repo}/pulls/1`, { accept: "application/vnd.github.diff" });
		expect(sent).toEqual([null, null]);
	});

	test("a full last page is reread whole, since a 304 cannot show that a next page appeared", async () => {
		const cache = diskResponseCache(directory());
		const full = Array.from({ length: 2 }, (_, id) => ({ id }));
		const { github, sent } = client(cache, [
			json(full, { etag: '"full"' }),
			json(full, { etag: '"full"' }),
			json(full.slice(1), { etag: '"part"', link: '<https://api.github.com/x>; rel="next"' }),
			notModified(),
			json(full.slice(1), { etag: '"tail"' }),
			notModified(),
		]);
		await github.list(`${repo}/pulls?per_page=2`);
		await github.list(`${repo}/pulls?per_page=2`);
		// A full page with a next link, and a page not full, both revalidate.
		await github.list(`${repo}/issues?per_page=2`);
		expect((await github.list(`${repo}/issues?per_page=2`)).response.headers.get("link")).toContain('rel="next"');
		await github.list(`${repo}/labels?per_page=2`);
		await github.list(`${repo}/labels?per_page=2`);
		expect(sent).toEqual([null, null, null, '"part"', null, '"tail"']);
	});

	test("writes, GraphQL, and answers without an ETag are never cached", async () => {
		const cache = diskResponseCache(directory());
		const { github, sent } = client(cache, [
			json({}, { etag: '"p"' }),
			json({ data: {} }, { etag: '"g"' }),
			json({}),
			json({}, { etag: '"p"' }),
			json({ data: {} }, { etag: '"g"' }),
			json({}),
		]);
		for (let round = 0; round < 2; round++) {
			await github.request(`${repo}/issues/1/labels`, { body: { labels: ["x"] } });
			await github.graphql("query { viewer { login } }", {});
			await github.request(`${repo}/pulls/2`);
		}
		expect(sent).toEqual([null, null, null, null, null, null]);
	});

	test("a failing cache warns once and leaves reads uncached", async () => {
		const warnings: string[] = [];
		const sent: (string | null)[] = [];
		const broken: ResponseCache = {
			get: async () => {
				throw new Error("EACCES: permission denied");
			},
			set: async () => {
				throw new Error("ENOSPC: no space left on device");
			},
		};
		const github = new GitHub({
			token: "token",
			quota: "fail",
			now: () => 0,
			sleep: async () => {},
			warn: (text) => warnings.push(text),
			cache: broken,
			fetch: (async (_input, init) => {
				sent.push(new Headers(init?.headers).get("If-None-Match"));
				return json({ id: 1 }, { etag: '"a"' });
			}) as typeof fetch,
		});
		for (let round = 0; round < 2; round++)
			expect(await (await github.request(`${repo}/pulls/1`)).json()).toEqual({ id: 1 });
		expect(sent).toEqual([null, null]);
		expect(warnings).toEqual(["GitHub response cache failed, reading uncached: EACCES: permission denied"]);
	});

	test("a 304 to a request that sent no ETag fails", async () => {
		const { github } = client(diskResponseCache(directory()), [notModified()]);
		await expect(github.request(`${repo}/pulls/1`)).rejects.toThrow("unexpected GitHub 304");
	});
});

describe("disk cache", () => {
	const entry = (body: string): CachedResponse => ({ etag: '"e"', headers: [["etag", '"e"']], body });
	const key = (n: number) => n.toString(16).padStart(64, "0");

	test("concurrent writers leave a readable cache", async () => {
		const path = directory();
		const writers = Array.from({ length: 8 }, () => diskResponseCache(path));
		await Promise.all(
			writers.flatMap((cache, writer) =>
				Array.from({ length: 20 }, (_, round) =>
					cache.set(key(round % 3), entry(`${writer}:${round}:${"x".repeat(5000)}`)),
				),
			),
		);
		for (let n = 0; n < 3; n++)
			expect((await diskResponseCache(path).get(key(n)))?.body).toMatch(/^\d+:\d+:x{5000}$/);
		expect(readdirSync(path).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("stays within its bound, evicting the least recently used first", async () => {
		const path = directory();
		const limit = 80_000;
		const cache = diskResponseCache(path, limit);
		const body = "x".repeat(9000);
		for (let n = 0; n < 4; n++) await cache.set(key(n), entry(body));
		// Reading the oldest makes it the most recently used.
		const old = new Date(Date.now() - 60_000);
		for (let n = 1; n < 4; n++) utimesSync(join(path, key(n)), old, old);
		utimesSync(join(path, key(0)), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
		await cache.get(key(0));
		// Nine entries pass the bound, so the three least recently used go.
		for (let n = 4; n < 9; n++) await cache.set(key(n), entry(body));
		expect(await cache.get(key(0))).toBeDefined();
		for (let n = 1; n < 4; n++) expect(await cache.get(key(n))).toBeUndefined();
		for (let n = 9; n < 40; n++) await cache.set(key(n), entry(body));
		const size = readdirSync(path).reduce((sum, name) => sum + statSync(join(path, name)).size, 0);
		expect(size).toBeLessThanOrEqual(limit);
		// An entry over an eighth of the bound is not kept.
		await cache.set(key(99), entry("y".repeat(limit / 8)));
		expect(await cache.get(key(99))).toBeUndefined();
	});

	test("processes sharing the cache count each other's writes", async () => {
		const path = directory();
		const limit = 80_000;
		const writers = [diskResponseCache(path, limit), diskResponseCache(path, limit)];
		const body = "x".repeat(9000);
		for (let n = 0; n < 40; n++) await writers[n % 2].set(key(n), entry(body));
		const size = readdirSync(path).reduce((sum, name) => sum + statSync(join(path, name)).size, 0);
		// Each writer sums the directory after every eighth of the bound it writes, so together they pass it by at most that each.
		expect(size).toBeLessThanOrEqual(limit + limit / 4);
		expect(readdirSync(path).length).toBeLessThan(20);
	});

	test("a damaged entry is a miss, and is removed", async () => {
		const path = directory();
		const cache = diskResponseCache(path);
		await cache.set(key(1), entry("ok"));
		writeFileSync(join(path, key(1)), "{not json");
		expect(await cache.get(key(1))).toBeUndefined();
		expect(readdirSync(path)).toEqual([]);
	});
});
