import { describe, expect, test } from "vitest";
import { claims, DEPTH, merge, tree, upstreamOf, workflows } from "../../src/board/load.ts";
import { SESSION, seal } from "../../src/session.ts";
import { env, harness, json, type Route } from "./fake.ts";

const GRAPHQL = "POST https://api.github.com/graphql";

/** A signed-in session cookie for `id`, valid well past the test clock. */
async function signedIn(id = 7) {
	const value = await seal(env.AUTH_SECRET, "session", {
		id,
		login: "octo",
		token: `ghu_${id}`,
		expires: Date.UTC(2030, 0),
		refresh: "ghr_x",
		refreshExpires: Date.UTC(2030, 0),
	});
	return `${SESSION}=${value}`;
}

/** GitHub's tree entries for a set of files under `quest/`. */
function entries(files: Record<string, string>, prefix = "quest/"): unknown[] {
	const here = new Map<string, Record<string, string>>();
	const out: unknown[] = [];
	for (const [path, text] of Object.entries(files)) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const [head, ...tail] = rest.split("/");
		if (tail.length === 0)
			out.push({ name: head, type: "blob", object: { text, isTruncated: false, byteSize: text.length } });
		else here.set(head!, { ...here.get(head!), [path]: text });
	}
	for (const [dir, sub] of here)
		out.push({ name: dir, type: "tree", object: { entries: entries(sub, `${prefix}${dir}/`) } });
	return out;
}

const FILES = {
	"quest/README.md": "# Quests\n\n## Goal\n\nShip.\n",
	"quest/m0/README.md": "# Now\n\n## Goal\n\nFirst.\n",
	"quest/m0/a.md":
		"# [S] Alpha\n\n## Goal\n\nSee [beta](/quest/m0/b.md), [docs](../../docs/x.md#y), and <script>alert(1)</script>.\n",
	"quest/m0/b.md": "# [M] Beta\n\n## Goal\n\nB.\n\n## Required\n\n- [Alpha](/quest/m0/a.md) - first\n",
	"quest/m0/c.md": "# [XS] Gamma\n\n## Goal\n\nC.\n\n## Waiting\n\n- Maintainer: pick a name\n",
	"quest/m0/d.md": "# [L] Delta\n\n## Goal\n\nD.\n",
};

function repository(files: Record<string, string> = FILES, extra: Record<string, unknown> = {}) {
	return {
		nameWithOwner: "moq-dev/quest",
		url: "https://github.com/moq-dev/quest",
		isPrivate: false,
		defaultBranchRef: { name: "main", target: { oid: "a".repeat(40), committedDate: "2026-11-24T10:00:00Z" } },
		object: { entries: entries(files) },
		pullRequests: {
			totalCount: 1,
			nodes: [
				{
					number: 12,
					url: "https://github.com/moq-dev/quest/pull/12",
					title: "Delta",
					isDraft: false,
					headRefName: "quest/m0/d",
					headRefOid: "d".repeat(40),
					createdAt: "2026-11-20T00:00:00Z",
					body: "",
					author: { login: "steelhead99x" },
				},
			],
		},
		refs: { totalCount: 1, nodes: [{ name: "m0/d" }] },
		...extra,
	};
}

function routes(repo: unknown = repository()): Record<string, Route> {
	return {
		[GRAPHQL]: () => json({ data: { repository: repo } }),
		"GET https://api.github.com/repos/moq-dev/quest/actions/runs": () =>
			json({ total_count: 0, workflow_runs: [] }),
		[`GET https://api.github.com/repos/moq-dev/quest/commits/${"d".repeat(40)}/check-runs`]: () =>
			json({ total_count: 0, check_runs: [] }),
	};
}

describe("board", () => {
	test("sends a signed-out visitor to sign in and back", async () => {
		const response = await harness(routes()).request("/repos/moq-dev/quest");
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/sign-in?next=%2Frepos%2Fmoq-dev%2Fquest");
	});

	test("shows stats, the ready ranking, waiting items, and each milestone", async () => {
		const h = harness(routes());
		const response = await h.request("/repos/moq-dev/quest", { cookies: [await signedIn()] });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Ready <strong>2</strong>");
		expect(html).toContain("In review <strong>1</strong>");
		expect(html).toContain("Blocked <strong>1</strong>");
		// Ready to start: Alpha unblocks Beta, so it ranks first.
		const ready = html.slice(html.indexOf("Ready to start"), html.indexOf("<h2>Waiting"));
		expect(ready.indexOf("Alpha")).toBeLessThan(ready.indexOf("Gamma"));
		expect(ready).toContain("unblocks 1");
		expect(ready).not.toContain("Delta");
		expect(html).toContain("<strong>Maintainer:</strong> pick a name");
		expect(html).toContain('href="https://github.com/moq-dev/quest/pull/12">#12</a>');
		expect(html).toContain('<span class="ql-size ql-l">L</span>');
		const graphql = h.requests.find((r) => r.url === "https://api.github.com/graphql")!;
		expect(graphql.headers.get("authorization")).toBe("Bearer ghu_7");
		// The tree in one GraphQL request, and the default branch's runs in one more.
		expect(response.headers.get("server-timing")).toContain('desc="2 requests"');
	});

	test("renders a quest page with tree links on the board, other files on GitHub, and raw HTML as text", async () => {
		const response = await harness(routes()).request("/repos/moq-dev/quest/quest/m0/a", {
			cookies: [await signedIn()],
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<h1>Alpha</h1>");
		expect(html).toContain('href="/repos/moq-dev/quest/quest/m0/b"');
		expect(html).toContain(`href="https://github.com/moq-dev/quest/blob/${"a".repeat(40)}/docs/x.md#y"`);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&#60;script&#62;");
	});

	test("says what blocks a blocked quest, as quest unblocked prints it", async () => {
		const html = await (
			await harness(routes()).request("/repos/moq-dev/quest/quest/m0/b", { cookies: [await signedIn()] })
		).text();
		expect(html).toContain("Blocked by");
		expect(html).toContain('Blocked by <a href="/repos/moq-dev/quest/quest/m0/a">Alpha</a>');
	});

	test("shows a review PR's claim on its quest page", async () => {
		const html = await (
			await harness(routes()).request("/repos/moq-dev/quest/quest/m0/d", { cookies: [await signedIn()] })
		).text();
		expect(html).toContain("In review");
		expect(html).toContain("by steelhead99x");
	});

	test("a missing repository, quest, or malformed name is a 404", async () => {
		const missing = harness({
			[GRAPHQL]: () =>
				json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
		});
		const r1 = await missing.request("/repos/moq-dev/nope", { cookies: [await signedIn()] });
		expect(r1.status).toBe(404);
		expect(await r1.text()).toContain("the App is not installed on it");
		const r2 = await harness(routes()).request("/repos/moq-dev/quest/quest/m0/zzz", {
			cookies: [await signedIn()],
		});
		expect(r2.status).toBe(404);
		const h = harness(routes());
		const r3 = await h.request("/repos/moq-dev/qu%22est", { cookies: [await signedIn()] });
		expect(r3.status).toBe(404);
		expect(h.requests).toEqual([]);
	});

	test("an invalid tree says so and ranks nothing", async () => {
		const files = {
			...FILES,
			"quest/m0/a.md": "# [S] Alpha\n\n## Goal\n\nA.\n\n## Required\n\n- [Beta](/quest/m0/b.md) - loop\n",
		};
		const html = await (
			await harness(routes(repository(files))).request("/repos/moq-dev/quest", { cookies: [await signedIn()] })
		).text();
		expect(html).toContain("Invalid quest tree");
		expect(html).toContain("Required cycle");
		expect(html).not.toContain("Ready to start");
	});

	test("reuses a person's board between pages but never shares it with another person", async () => {
		const h = harness(routes());
		await h.request("/repos/moq-dev/quest", { cookies: [await signedIn(7)] });
		await h.request("/repos/moq-dev/quest/quest/m0/a", { cookies: [await signedIn(7)] });
		expect(h.requests.filter((r) => r.url.endsWith("/graphql"))).toHaveLength(1);
		await h.request("/repos/moq-dev/quest", { cookies: [await signedIn(8)] });
		expect(h.requests.filter((r) => r.url.endsWith("/graphql"))).toHaveLength(2);
	});
});

describe("loader", () => {
	test("reports a directory deeper than it reads, and a file too large to show", () => {
		const t = tree({
			...repository(),
			object: {
				entries: [
					{ name: "README.md", type: "blob", object: { text: "# Q\n\n## Goal\n\nG.\n", isTruncated: false } },
					{ name: "deep", type: "tree", object: {} },
					{ name: "big.md", type: "blob", object: { text: null, isTruncated: true } },
					{ name: "image.png", type: "blob", object: { text: null } },
				],
			},
		});
		expect(t.documents.map((d) => d.path)).toEqual(["quest/README.md"]);
		expect(t.gaps).toEqual([
			`quest/deep/ is deeper than ${DEPTH} directories; its quests are not shown`,
			"quest/big.md is too large or not text; it is not shown",
		]);
		expect(t.branches).toEqual(["quest/m0/d"]);
	});

	test("refuses an answer that is not the query's shape", () => {
		expect(() => tree({})).toThrow("repository name");
		expect(() => tree({ ...repository(), defaultBranchRef: null })).toThrow("default branch");
		expect(() => tree({ ...repository(), pullRequests: {} })).toThrow("pull requests");
		expect(() =>
			tree({ ...repository(), object: { entries: [{ name: "../x", type: "blob", object: {} }] } }),
		).toThrow("tree entry");
	});

	test("an empty repository shows no tree rather than failing", async () => {
		const html = await (
			await harness(routes(repository({}, { object: null }))).request("/repos/moq-dev/quest", {
				cookies: [await signedIn()],
			})
		).text();
		expect(html).toContain("No quest tree on main.");
	});
});

const RUNS = "GET https://api.github.com/repos/moq-dev/quest/actions/runs";
const run = (id: number, extra: Record<string, unknown> = {}) => ({
	id,
	name: `Check ${id}`,
	status: "completed",
	conclusion: "failure",
	html_url: `https://github.com/moq-dev/quest/actions/runs/${id}`,
	head_repository: { full_name: "moq-dev/quest" },
	run_started_at: "2026-11-25T11:00:00Z",
	updated_at: "2026-11-25T11:03:05Z",
	...extra,
});
const WORKFLOWS = {
	entries: [
		{ name: "check.yml", type: "blob", object: { text: "name: Check\non:\n  push:\n  workflow_dispatch:\n" } },
		{
			name: "release.yml",
			type: "blob",
			object: { text: "name: Release\non: push\n# workflow_dispatch is off\n" },
		},
		{
			name: "named.yml",
			type: "blob",
			object: { text: 'name: "Run workflow_dispatch by hand"\non: push\n' },
		},
		{
			name: "tag.yaml",
			type: "blob",
			object: {
				text: "name: Tag\non:\n  workflow_dispatch:\n    inputs:\n      tag:\n        required: true\n      dry:\n        required: true\n        default: false\n",
			},
		},
		{ name: "list.yml", type: "blob", object: { text: "name: List\non: [push, workflow_dispatch]\n" } },
		{ name: "broken.yml", type: "blob", object: { text: "name: [unclosed\n" } },
		{ name: "notes.txt", type: "blob", object: { text: "workflow_dispatch" } },
	],
};

describe("CI", () => {
	test("a quest page shows its PR's checks and runs, offering a re-run only for a failed run", async () => {
		const h = harness({
			...routes(),
			[`GET https://api.github.com/repos/moq-dev/quest/commits/${"d".repeat(40)}/check-runs`]: () =>
				json({
					total_count: 31,
					check_runs: [
						{
							id: 1,
							name: "lint",
							status: "completed",
							conclusion: "success",
							html_url: "https://x/1",
							started_at: "2026-11-25T11:00:00Z",
							completed_at: "2026-11-25T11:00:42Z",
						},
					],
				}),
			[RUNS]: (r) => {
				expect(new URL(r.url).searchParams.get("head_sha")).toBe("d".repeat(40));
				return json({
					total_count: 4,
					workflow_runs: [
						run(10),
						run(11, { conclusion: "success" }),
						run(12, { conclusion: "action_required" }),
						run(13, { head_repository: { full_name: "mallory/quest" } }),
					],
				});
			},
		});
		const html = await (await h.request("/repos/moq-dev/quest/quest/m0/d", { cookies: [await signedIn()] })).text();
		expect(html).toContain("<h2>CI</h2>");
		expect(html).toContain(">lint</a>");
		expect(html).toContain("42s");
		expect(html).toContain("3m 05s");
		expect(html.match(/Re-run failed jobs/g)).toHaveLength(1);
		expect(html).toContain("From a fork: re-run it on GitHub");
		expect(html).toContain('action="/repos/moq-dev/quest/runs/10/rerun"');
		expect(html).toContain("Approve it on GitHub");
		// 31 check runs exist and 30 are read.
		expect(html).toContain('<a href="https://github.com/moq-dev/quest/pull/12/checks">All runs on GitHub</a>');
	});

	test("the board shows the default branch's runs and only the dispatchable workflows", async () => {
		const h = harness({
			...routes(repository(FILES, { workflows: WORKFLOWS })),
			[RUNS]: (r) => {
				expect(new URL(r.url).searchParams.get("branch")).toBe("main");
				return json({ total_count: 1, workflow_runs: [run(20, { conclusion: "success" })] });
			},
		});
		const html = await (await h.request("/repos/moq-dev/quest", { cookies: [await signedIn()] })).text();
		expect(html).toContain("CI on main");
		expect(html).toContain("Check 20");
		expect(html).toContain('action="/repos/moq-dev/quest/workflows/check.yml/dispatch"');
		expect(html).not.toContain("release.yml/dispatch");
		expect(html).not.toContain("named.yml/dispatch");
		// A required input with no default can't be given by the form, so the row links to GitHub.
		expect(html).not.toContain("tag.yaml/dispatch");
		expect(html).toContain('href="https://github.com/moq-dev/quest/actions/workflows/tag.yaml"');
		expect(html).toContain("Needs inputs");
	});

	test("reads workflow names and triggers from the YAML, not from its text", () => {
		expect(workflows(WORKFLOWS.entries)).toEqual([
			{ file: "broken.yml", name: "broken.yml", dispatch: false, inputs: false },
			{ file: "check.yml", name: "Check", dispatch: true, inputs: false },
			{ file: "list.yml", name: "List", dispatch: true, inputs: false },
			{ file: "named.yml", name: "Run workflow_dispatch by hand", dispatch: false, inputs: false },
			{ file: "release.yml", name: "Release", dispatch: false, inputs: false },
			{ file: "tag.yaml", name: "Tag", dispatch: true, inputs: true },
		]);
		expect(workflows(undefined)).toEqual([]);
	});

	test("re-runs a failed run after rechecking it with GitHub", async () => {
		let posted = false;
		const h = harness({
			"GET https://api.github.com/repos/moq-dev/quest/actions/runs/10": () => json(run(10)),
			"POST https://api.github.com/repos/moq-dev/quest/actions/runs/10/rerun-failed-jobs": () => (
				(posted = true),
				json({}, 201)
			),
		});
		const response = await h.request("/repos/moq-dev/quest/runs/10/rerun", {
			method: "POST",
			headers: { origin: "https://quest.test", "content-type": "application/x-www-form-urlencoded" },
			body: "next=%2Frepos%2Fmoq-dev%2Fquest%2Fquest%2Fm0%2Fd",
			cookies: [await signedIn()],
		});
		expect(response.status).toBe(200);
		expect(posted).toBe(true);
		const html = await response.text();
		expect(html).toContain("Re-run started");
		expect(html).toContain('href="/repos/moq-dev/quest/quest/m0/d"');
		const call = h.requests.find((r) => r.method === "POST")!;
		expect(call.headers.get("authorization")).toBe("Bearer ghu_7");
	});

	test.each([
		["a run awaiting approval", run(10, { conclusion: "action_required" }), "waiting for a maintainer"],
		["a run that passed", run(10, { conclusion: "success" }), "no failed jobs"],
		["a run still going", run(10, { status: "in_progress", conclusion: null }), "no failed jobs"],
		["a fork's finished failure", run(10, { head_repository: { full_name: "mallory/quest" } }), "ran from a fork"],
		["a run whose source is unknown", run(10, { head_repository: null }), "ran from a fork"],
	])("refuses to re-run %s", async (_, value, message) => {
		const h = harness({ "GET https://api.github.com/repos/moq-dev/quest/actions/runs/10": () => json(value) });
		const response = await h.request("/repos/moq-dev/quest/runs/10/rerun", {
			method: "POST",
			headers: { origin: "https://quest.test", "content-type": "application/x-www-form-urlencoded" },
			body: "next=%2F",
			cookies: [await signedIn()],
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toContain(message);
		expect(h.requests.filter((r) => r.method === "POST")).toEqual([]);
	});

	test("shows GitHub's refusal when the person lacks write access", async () => {
		const h = harness({
			"GET https://api.github.com/repos/moq-dev/quest/actions/runs/10": () => json(run(10)),
			"POST https://api.github.com/repos/moq-dev/quest/actions/runs/10/rerun-failed-jobs": () =>
				json({ message: "Must have admin rights to Repository." }, 403),
		});
		const response = await h.request("/repos/moq-dev/quest/runs/10/rerun", {
			method: "POST",
			headers: { origin: "https://quest.test", "content-type": "application/x-www-form-urlencoded" },
			body: "next=%2F",
			cookies: [await signedIn()],
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("Must have admin rights to Repository.");
	});

	test("actions refuse another site's post and a signed-out one", async () => {
		const h = harness();
		const other = await h.request("/repos/moq-dev/quest/runs/10/rerun", {
			method: "POST",
			headers: { origin: "https://evil.example" },
			cookies: [await signedIn()],
		});
		expect(other.status).toBe(403);
		const out = await h.request("/repos/moq-dev/quest/runs/10/rerun", {
			method: "POST",
			headers: { origin: "https://quest.test" },
		});
		expect(out.status).toBe(401);
		expect(h.requests).toEqual([]);
	});

	test("dispatches a workflow on the default branch, and only one with the trigger", async () => {
		let body: unknown = null;
		const h = harness({
			...routes(repository(FILES, { workflows: WORKFLOWS })),
			"POST https://api.github.com/repos/moq-dev/quest/actions/workflows/check.yml/dispatches": async (r) => (
				(body = await r.json()),
				new Response(null, { status: 204 })
			),
		});
		const post = (file: string) =>
			h.request(`/repos/moq-dev/quest/workflows/${file}/dispatch`, {
				method: "POST",
				headers: { origin: "https://quest.test", "content-type": "application/x-www-form-urlencoded" },
				body: "next=%2Frepos%2Fmoq-dev%2Fquest",
				cookies: [signed],
			});
		const signed = await signedIn();
		const ok = await post("check.yml");
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain("GitHub queued Check on main.");
		expect(body).toEqual({ ref: "main" });
		expect((await post("release.yml")).status).toBe(409);
		expect((await post("named.yml")).status).toBe(409);
		const inputs = await post("tag.yaml");
		expect(inputs.status).toBe(409);
		expect(await inputs.text()).toContain("needs inputs");
	});
});

describe("private data", () => {
	test("a page rendered for a signed-in person is never stored; a signed-out one may be", async () => {
		const h = harness(routes());
		const signed = await h.request("/repos/moq-dev/quest", { cookies: [await signedIn()] });
		expect(signed.headers.get("cache-control")).toBe("private, no-store");
		const out = await h.request("/");
		expect(out.headers.get("cache-control")).toBe("no-cache");
	});

	test("the offline page is public and names no one", async () => {
		const response = await harness().request("/offline", { cookies: [await signedIn()] });
		const html = await response.text();
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(html).toContain("You&#39;re offline");
		expect(html).not.toContain("octo");
	});

	test("a cached private board is rechecked with GitHub, and revoked access ends at once", async () => {
		let allowed = true;
		const h = harness({
			...routes(repository(FILES, { isPrivate: true })),
			"GET https://api.github.com/repos/moq-dev/quest": () =>
				allowed ? json({ full_name: "moq-dev/quest" }) : json({ message: "Not Found" }, 404),
		});
		const cookie = await signedIn();
		expect((await h.request("/repos/moq-dev/quest", { cookies: [cookie] })).status).toBe(200);
		expect((await h.request("/repos/moq-dev/quest", { cookies: [cookie] })).status).toBe(200);
		expect(h.requests.filter((r) => r.url.endsWith("/repos/moq-dev/quest"))).toHaveLength(1);
		allowed = false;
		expect((await h.request("/repos/moq-dev/quest", { cookies: [cookie] })).status).toBe(404);
	});

	test("a cached public board is not rechecked", async () => {
		const h = harness(routes());
		const cookie = await signedIn();
		await h.request("/repos/moq-dev/quest", { cookies: [cookie] });
		await h.request("/repos/moq-dev/quest", { cookies: [cookie] });
		expect(h.requests.filter((r) => r.url.endsWith("/repos/moq-dev/quest"))).toHaveLength(0);
	});
});

describe("claims, as the CLI reads them", () => {
	const UPSTREAM_PR = {
		number: 77,
		url: "https://github.com/moq-dev/quest/pull/77",
		title: "Alpha upstream",
		isDraft: true,
		headRefName: "quest/m0/a",
		headRefOid: "e".repeat(40),
		createdAt: "2026-11-19T00:00:00Z",
		body: "",
		author: { login: "kixelated" },
	};

	/** The fork steelhead99x/quest, whose parent moq-dev/quest keeps the quest tree. */
	function fork(extra: Record<string, unknown> = {}) {
		return repository(FILES, {
			nameWithOwner: "steelhead99x/quest",
			url: "https://github.com/steelhead99x/quest",
			parent: { nameWithOwner: "moq-dev/quest", tree: { id: "x" }, parent: null },
			pullRequests: { totalCount: 0, nodes: [] },
			refs: { totalCount: 0, nodes: [] },
			...extra,
		});
	}

	test("a fork's board counts its upstream's claims", async () => {
		let upstreamAsked = false;
		const h = harness({
			...routes(),
			[GRAPHQL]: async (r) => {
				const { query, variables } = (await r.json()) as { query: string; variables: { owner: string } };
				if (query.includes("query Upstream")) {
					upstreamAsked = true;
					expect(variables.owner).toBe("moq-dev");
					return json({
						data: {
							repository: {
								pullRequests: { totalCount: 1, nodes: [UPSTREAM_PR] },
								refs: { totalCount: 0, nodes: [] },
							},
						},
					});
				}
				return json({ data: { repository: fork() } });
			},
			"GET https://api.github.com/repos/steelhead99x/quest/actions/runs": () =>
				json({ total_count: 0, workflow_runs: [] }),
		});
		const html = await (await h.request("/repos/steelhead99x/quest", { cookies: [await signedIn()] })).text();
		expect(upstreamAsked).toBe(true);
		const ready = html.slice(html.indexOf("Ready to start"), html.indexOf("<h2>Waiting"));
		expect(ready).not.toContain("Alpha");
		expect(html).toContain('href="https://github.com/moq-dev/quest/pull/77">#77</a>');
	});

	/** A fork board whose quest m0/a is claimed by moq-dev/quest#77, with `ci` answering the upstream's CI. */
	function forkClaimed(ci: Record<string, Route>) {
		return harness({
			...routes(),
			[GRAPHQL]: async (r) => {
				const { query } = (await r.json()) as { query: string };
				if (query.includes("query Upstream"))
					return json({
						data: {
							repository: {
								pullRequests: { totalCount: 1, nodes: [UPSTREAM_PR] },
								refs: { totalCount: 0, nodes: [] },
							},
						},
					});
				return json({ data: { repository: fork() } });
			},
			...ci,
		});
	}

	test("a fork's quest page reads an upstream claim's CI from the upstream", async () => {
		const sha = "e".repeat(40);
		const h = forkClaimed({
			[`GET https://api.github.com/repos/moq-dev/quest/commits/${sha}/check-runs`]: () =>
				json({ total_count: 0, check_runs: [] }),
			"GET https://api.github.com/repos/moq-dev/quest/actions/runs": (r) => {
				expect(new URL(r.url).searchParams.get("head_sha")).toBe(sha);
				return json({ total_count: 1, workflow_runs: [run(40, { conclusion: "success", head_sha: sha })] });
			},
		});
		const response = await h.request("/repos/steelhead99x/quest/quest/m0/a", { cookies: [await signedIn()] });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Check 40");
		expect(h.requests.some((r) => r.url.includes("/repos/steelhead99x/quest/actions"))).toBe(false);
	});

	test("a quest page whose PR's CI can't be read still shows, linking to the checks", async () => {
		const h = forkClaimed({});
		const response = await h.request("/repos/steelhead99x/quest/quest/m0/a", { cookies: [await signedIn()] });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("can&#39;t read moq-dev/quest&#39;s CI");
		expect(html).toContain('href="https://github.com/moq-dev/quest/pull/77/checks"');
	});

	test("a parent without a quest tree is not an upstream", () => {
		expect(upstreamOf(fork({ parent: { nameWithOwner: "someone/quest", tree: null, parent: null } }))).toBe(
			"steelhead99x/quest",
		);
		expect(
			upstreamOf(
				fork({
					parent: {
						nameWithOwner: "moq-dev/quest",
						tree: { id: "x" },
						parent: { nameWithOwner: "kixel-ai/quest", tree: { id: "y" }, parent: null },
					},
				}),
			),
		).toBe("kixel-ai/quest");
	});

	test("a retained branch whose tip landed holds nothing", () => {
		const tip = "f".repeat(40);
		const t = tree(
			repository(FILES, {
				pullRequests: { totalCount: 0, nodes: [] },
				refs: {
					totalCount: 2,
					nodes: [
						{
							name: "m0/a",
							target: { oid: tip },
							associatedPullRequests: { nodes: [{ headRefOid: tip }] },
						},
						// Pushed to again after its PR merged: its new tip is work that has not landed.
						{
							name: "m0/c",
							target: { oid: "1".repeat(40) },
							associatedPullRequests: { nodes: [{ headRefOid: tip }] },
						},
					],
				},
			}),
		);
		expect(t.branches).toEqual(["quest/m0/c"]);
		expect(t.upstream).toBe("moq-dev/quest");
	});

	test("the earliest open PR across the fork and its upstream holds the claim", () => {
		const own = {
			...UPSTREAM_PR,
			number: 3,
			url: "https://github.com/steelhead99x/quest/pull/3",
			createdAt: "2026-11-21T00:00:00Z",
		};
		const t = tree(fork({ pullRequests: { totalCount: 1, nodes: [own] } }));
		const merged = merge(
			t,
			claims(
				{ pullRequests: { totalCount: 1, nodes: [UPSTREAM_PR] }, refs: { totalCount: 0, nodes: [] } },
				"moq-dev/quest",
			),
		);
		expect(merged.pulls.map((p) => p.number)).toEqual([77, 3]);
	});
});
