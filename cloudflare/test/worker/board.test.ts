import { describe, expect, test } from "vitest";
import { DEPTH, tree, workflows } from "../../src/board/load.ts";
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
		expect(html).toContain("quest/m0/a.md");
	});

	test("shows a review PR's claim on its quest page", async () => {
		const html = await (
			await harness(routes()).request("/repos/moq-dev/quest/quest/m0/d", { cookies: [await signedIn()] })
		).text();
		expect(html).toContain("ready for review");
		expect(html).toContain("from steelhead99x");
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
		expect(html).toContain("The quest tree is invalid");
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
		expect(html).toContain("This repository has no quest tree on main.");
	});
});

const RUNS = "GET https://api.github.com/repos/moq-dev/quest/actions/runs";
const run = (id: number, extra: Record<string, unknown> = {}) => ({
	id,
	name: `Check ${id}`,
	status: "completed",
	conclusion: "failure",
	html_url: `https://github.com/moq-dev/quest/actions/runs/${id}`,
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
					total_count: 3,
					workflow_runs: [
						run(10),
						run(11, { conclusion: "success" }),
						run(12, { conclusion: "action_required" }),
					],
				});
			},
		});
		const html = await (await h.request("/repos/moq-dev/quest/quest/m0/d", { cookies: [await signedIn()] })).text();
		expect(html).toContain("Checks on #12");
		expect(html).toContain(">lint</a>");
		expect(html).toContain("42s");
		expect(html).toContain("3m 05s");
		expect(html.match(/Re-run failed jobs/g)).toHaveLength(1);
		expect(html).toContain('action="/repos/moq-dev/quest/runs/10/rerun"');
		expect(html).toContain("Waiting for a maintainer to approve it on GitHub");
		// 31 check runs exist and 30 are shown.
		expect(html).toContain('More on <a href="https://github.com/moq-dev/quest/pull/12/checks">GitHub</a>');
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
	});

	test("reads workflow names and triggers, ignoring a commented trigger", () => {
		expect(workflows(WORKFLOWS.entries)).toEqual([
			{ file: "check.yml", name: "Check", dispatch: true },
			{ file: "release.yml", name: "Release", dispatch: false },
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
		["a run awaiting approval", run(10, { conclusion: "action_required" }), "approve it on GitHub"],
		["a run that passed", run(10, { conclusion: "success" }), "no failed jobs"],
		["a run still going", run(10, { status: "in_progress", conclusion: null }), "no failed jobs"],
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
	});
});
