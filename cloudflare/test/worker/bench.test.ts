import { describe, expect, test } from "vitest";
import { MAX_MERGED, type Merged, window } from "../../src/bench/load.ts";
import { rollups, row } from "../../src/bench/model.ts";
import { SESSION, seal } from "../../src/session.ts";
import { env, harness, json } from "./fake.ts";

const NOW = Date.UTC(2026, 10, 25, 12);

/** A PR body with the records `quest review` and an implementer write. */
function body(size: string, implementer: string, score: number, rounds: number) {
	return [
		"Does the thing.",
		"",
		"## Models",
		"",
		`- Size: ${size}`,
		`- Implementer: ${implementer}`,
		"",
		"## Review",
		"",
		"Rewritten by `quest review` after each round.",
		"",
		`- Head: ${"b".repeat(40)}`,
		`- Base: origin/main at ${"a".repeat(12)}`,
		"",
		"- Reviewer: Codex, gpt-6.1-sol, high effort",
		"- Session: `t1`, round 2",
		`- Score: ${score}/10, \`Fine.\``,
		`- Rounds: ${rounds}; first round 1 (high 1); findings 2 (high 1, low 1): fixed 1, refuted 1, open 0`,
		"- Findings: none",
		"",
		"- Reviewer: Codex, gpt-6.1-sol, medium effort, shadow",
		"- Session: `t2`, round 2",
		"- Score: 2/10, `Shadow.`",
		"- Rounds: 9; findings 0: fixed 0, refuted 0, open 0",
		"- Findings: none",
	].join("\n");
}

const merged = (n: number, extra: Partial<Merged> = {}): Merged => ({
	number: n,
	url: `https://github.com/o/r/pull/${n}`,
	title: `PR ${n}`,
	branch: `quest/m0/q${n}`,
	body: body("M", "Claude Code, claude-opus-5-5, medium effort", 9, 2),
	created: "2026-11-20T00:00:00Z",
	merged: "2026-11-21T06:00:00Z",
	checks: [
		{ started: "2026-11-21T05:00:00Z", completed: "2026-11-21T05:04:00Z" },
		{ started: "2026-11-21T05:01:00Z", completed: "2026-11-21T05:10:30Z" },
	],
	...extra,
});

describe("bench rows", () => {
	test("read the PR's records with the CLI's parsers, leaving out the shadow", () => {
		expect(row(merged(1))).toEqual({
			number: 1,
			url: "https://github.com/o/r/pull/1",
			title: "PR 1",
			size: "M",
			models: ["claude-opus-5-5"],
			score: 9,
			rounds: 2,
			hours: 30,
			ci: 10.5,
			unreadable: null,
		});
	});

	test("a display name resolves to the model's ID, as quest usage reads it", () => {
		expect(row(merged(1, { body: body("S", "Claude Code, Opus 5.5, medium effort", 9, 1) })).models).toEqual([
			"claude-opus-5-5",
		]);
	});

	test("an unreadable review record marks the row rather than failing the page", () => {
		const r = row(
			merged(1, {
				body: "## Review\n\nRewritten by `quest review` after each round.\n\n- Reviewer: Codex, gpt-6.1-sol, high effort\n- Rounds: garbled\n",
			}),
		);
		expect(r.unreadable).toContain("Rounds line is malformed");
		expect(r.score).toBeNull();
	});

	test("a low-risk head's record, which seats no reviewer, reads as unreviewed rather than unreadable", () => {
		const r = row(
			merged(1, { body: "## Review\n\nRewritten by `quest review` after each round.\n\n- Risk: low\n" }),
		);
		expect(r.unreadable).toBeNull();
		expect(r).toMatchObject({ score: null, rounds: null });
	});

	test("a PR with no records or checks still has its timing", () => {
		const r = row(merged(1, { body: "", checks: [] }));
		expect(r).toMatchObject({ size: null, models: [], score: null, rounds: null, ci: null, hours: 30 });
	});

	test("rollups take medians by size, in ladder order, and by writer", () => {
		const rows = [
			row(merged(1)),
			row(merged(2, { body: body("M", "Codex, gpt-6.1-sol, high effort", 7, 4) })),
			row(merged(3, { body: body("XS", "Claude Code, claude-sonnet-5-5, high effort", 10, 1) })),
			row(merged(4, { body: "" })),
		];
		const { sizes, writers } = rollups(rows);
		expect(sizes.map((s) => [s.key, s.pulls, s.score, s.rounds])).toEqual([
			["XS", 1, 10, 1],
			["M", 2, 8, 3],
			["unsized", 1, null, null],
		]);
		expect(writers.map((w) => [w.key, w.pulls])).toEqual([
			["claude-opus-5-5", 1],
			["claude-sonnet-5-5", 1],
			["gpt-6.1-sol", 1],
			["unrecorded", 1],
		]);
	});
});

describe("bench window", () => {
	const node = (n: number, merged: string, branch = `quest/m0/q${n}`) => ({
		number: n,
		url: "u",
		title: "t",
		headRefName: branch,
		body: "",
		createdAt: "2026-11-01T00:00:00Z",
		mergedAt: merged,
		updatedAt: merged,
		commits: { nodes: [] },
	});

	test("keeps quest branches merged inside the window", () => {
		const w = window(
			{
				pullRequests: {
					pageInfo: { hasNextPage: false },
					nodes: [
						node(1, "2026-11-24T00:00:00Z"),
						node(2, "2026-11-24T00:00:00Z", "fix/x"),
						node(3, "2026-10-01T00:00:00Z"),
					],
				},
			},
			NOW,
		);
		expect(w.pulls.map((p) => p.number)).toEqual([1]);
		expect(w.cut).toBe(false);
	});

	test("says when a full page leaves older merges unread", () => {
		const nodes = Array.from({ length: MAX_MERGED }, (_, i) => node(i + 1, "2026-11-24T00:00:00Z"));
		nodes[0] = { ...node(99, "2026-10-01T00:00:00Z"), updatedAt: "2026-11-25T00:00:00Z" };
		expect(window({ pullRequests: { nodes, pageInfo: { hasNextPage: true } } }, NOW).cut).toBe(true);
		expect(window({ pullRequests: { nodes, pageInfo: { hasNextPage: false } } }, NOW).cut).toBe(false);
	});

	test("refuses an answer without pull requests or merge times", () => {
		expect(() => window(null, NOW)).toThrow("no pull requests");
		expect(() =>
			window({ pullRequests: { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } } }, NOW),
		).toThrow("merge time");
	});
});

describe("bench page", () => {
	test("renders rollups and rows for a signed-in person, from one GraphQL request", async () => {
		const cookie = `${SESSION}=${await seal(env.AUTH_SECRET, "session", {
			sid: "00000000-0000-4000-8000-000000000007",
			id: 7,
			login: "octo",
			token: "ghu_7",
			expires: Date.UTC(2030, 0),
			refresh: "r",
			refreshExpires: Date.UTC(2030, 0),
		})}`;
		const h = harness({
			"POST https://api.github.com/graphql": async (r) => {
				const { query } = (await r.json()) as { query: string };
				expect(query).toContain("query Bench");
				return json({
					data: {
						repository: {
							pullRequests: {
								pageInfo: { hasNextPage: false },
								nodes: [
									{
										number: 5,
										url: "https://github.com/moq-dev/quest/pull/5",
										title: "Make it",
										headRefName: "quest/m0/make",
										body: body("L", "Claude Code, claude-opus-5-5, high effort", 9, 3),
										createdAt: "2026-11-24T00:00:00Z",
										mergedAt: "2026-11-24T12:00:00Z",
										updatedAt: "2026-11-24T12:00:00Z",
										commits: { nodes: [] },
									},
								],
							},
						},
					},
				});
			},
		});
		h.advance(-1);
		const response = await h.request("/repos/moq-dev/quest/bench", { cookies: [cookie] });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('Make it <span class="muted">#5</span>');
		expect(html).toContain('<span class="ql-size ql-l">L</span>');
		expect(html).toContain('<span class="muted">claude-opus-5-5</span>');
		expect(html).toContain("9/10");
		expect(html).toContain("12.0h to merge");
		expect(response.headers.get("server-timing")).toContain('desc="1 requests"');
	});

	test("sends a signed-out visitor to sign in", async () => {
		const response = await harness().request("/repos/moq-dev/quest/bench");
		expect(response.headers.get("location")).toBe("/sign-in?next=%2Frepos%2Fmoq-dev%2Fquest%2Fbench");
	});
});
