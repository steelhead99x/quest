// `quest pr view`: a PR's title, body, and discussion, read from a fake Kixel Quest that never lets a request reach
// GitHub, and from GitHub's GraphQL answers, and the wire it travels in.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type PullView, forgeJson, parseForgeAnswer, parseForgeRequest } from "../src/core";
import { type Output, main } from "../src/cli/main";
import type { GitHub } from "../src/github/client";
import { pullView } from "../src/github/view";
import { FakeKixelQuest, KIXEL, REPOSITORY, kixelEnv } from "./kixel-fakes";

let kixel: FakeKixelQuest;
beforeEach(() => {
	kixel = new FakeKixelQuest();
	for (const [name, value] of Object.entries(kixelEnv())) vi.stubEnv(name, value);
	vi.stubEnv("GH_TOKEN", "");
	vi.stubEnv("GITHUB_TOKEN", "");
	vi.stubGlobal("fetch", kixel.fetch);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const out: Output = { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) };
	const code = await main(args, out);
	return { code, stdout, stderr };
}

describe("quest pr view on a repository Kixel Quest hosts", () => {
	test("prints the body, comments and reviews by time, and each thread with its comments", async () => {
		const pull = kixel.add({
			branch: "quest/m0/one",
			title: "One",
			body: "Does one.\n\n## Waiting\n\n- Maintainer: pick.",
			threads: new Map([
				["thread-1", false],
				["thread-2", true],
			]),
			reviews: [
				{
					reviewer: "pullfrog",
					state: "changes_requested",
					body: "[P1] Off by one.",
					commit: "a".repeat(40),
					// Between the two comments.
					submittedAt: new Date(Date.parse("2026-11-17T00:00:00Z") + 2).toISOString(),
					url: `${KIXEL}/example/project/pull/1#review-1`,
				},
			],
		});
		const url = kixel.url(pull.number);
		expect((await cli("pr", "comment", url, "--body", "First.")).code).toBe(0);
		expect((await cli("pr", "comment", url, "--thread", "thread-1", "--body", "Fixed.\nIn the head.")).code).toBe(
			0,
		);
		expect((await cli("pr", "comment", url, "--body", "Second.")).code).toBe(0);

		const plain = await cli("pr", "view", url);
		expect(plain.stderr).toBe("");
		expect(plain.code).toBe(0);
		expect(plain.stdout).toBe(
			[
				`url ${url}`,
				"state open",
				"draft false",
				"author agent",
				"title One",
				"--",
				"body",
				"Does one.\n\n## Waiting\n\n- Maintainer: pick.",
				"--",
				`comment agent 2026-11-17T00:00:00.001Z ${url}#comment-1`,
				"First.",
				"--",
				`review changes_requested pullfrog 2026-11-17T00:00:00.002Z ${KIXEL}/example/project/pull/1#review-1`,
				"[P1] Off by one.",
				"--",
				`comment agent 2026-11-17T00:00:00.003Z ${url}#comment-3`,
				"Second.",
				"--",
				"thread thread-1 current unresolved src/main.ts:1",
				"--",
				`comment agent 2026-11-17T00:00:00.002Z ${url}#comment-2`,
				"Fixed.\nIn the head.",
				"--",
				"thread thread-2 current resolved src/main.ts:1",
				"",
			].join("\n"),
		);

		const json = await cli("pr", "view", url, "--json");
		const view = JSON.parse(json.stdout) as PullView;
		expect([view.title, view.comments.length, view.reviews.length, view.threads[0]!.comments[0]!.body]).toEqual([
			"One",
			2,
			1,
			"Fixed.\nIn the head.",
		]);
		expect(kixel.calls.filter(({ call }) => call === "view")).toHaveLength(2);
	});

	test("a failure fails the command, and nothing reaches GitHub", async () => {
		const pull = kixel.add({ branch: "feature" });
		kixel.fail = { status: 503, error: "down", call: "view" };
		expect(await cli("pr", "view", kixel.url(pull.number))).toEqual({
			code: 1,
			stdout: "",
			stderr: `quest: Kixel Quest (${KIXEL}) failed POST /forge/view: HTTP 503, down\n`,
		});
	});
});

describe("quest pr view on a GitHub repository Kixel Quest serves", () => {
	const url = "https://github.com/example/project/pull/1";

	test("reads the view through the forge, with no GitHub token and no minted one", async () => {
		kixel.served = ["example/project"];
		kixel.add({ branch: "feature", title: "Feature" });
		const out = await cli("pr", "view", url, "--json");
		expect(out.code, out.stderr).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({ title: "Feature" });
		expect(kixel.requests).toEqual(["GET /forge", "POST /forge/view"]);
	});

	test("a rate-limited read fails, naming when to retry", async () => {
		kixel.served = ["example/project"];
		kixel.add({ branch: "feature" });
		kixel.fail = { status: 429, error: "read budget spent", call: "view", retryAfter: "30" };
		expect(await cli("pr", "view", url)).toEqual({
			code: 1,
			stdout: "",
			stderr: `quest: Kixel Quest (${KIXEL}) failed POST /forge/view: it is rate limiting your requests (HTTP 429, read budget spent); try again in 30 seconds; rerun this command with QUEST_FORGE=github; leave it unset otherwise, since it spends your GitHub quota\n`,
		});
	});
});

describe("the view wire", () => {
	const pull = { ...REPOSITORY, number: 3 };
	const view: PullView = {
		url: "u",
		title: "T",
		author: "a",
		state: "merged",
		draft: false,
		body: "",
		comments: [{ author: "a", body: "", createdAt: "2026-11-17T00:00:00Z", url: "c" }],
		reviews: [
			{ reviewer: "r", state: "approved", body: "", commit: null, submittedAt: "2026-11-17T00:00:00Z", url: "v" },
		],
		threads: [{ id: "t", path: "p", line: null, outdated: true, resolved: false, comments: [] }],
	};

	test("round-trips, and refuses what Kixel Quest would", () => {
		expect(parseForgeRequest("view", JSON.parse(forgeJson({ pull })))).toEqual({ pull });
		expect(() => parseForgeRequest("view", { pull, labels: [] })).toThrow("no such field");
		expect(parseForgeAnswer("view", JSON.parse(forgeJson({ value: view, asOf: null }))).value).toEqual(view);
		expect(() => parseForgeAnswer("view", { value: { ...view, state: "draft" }, asOf: null })).toThrow(
			"answer.value.state",
		);
		expect(() =>
			parseForgeAnswer("view", { value: { ...view, threads: [{ ...view.threads[0], line: -1 }] }, asOf: null }),
		).toThrow("answer.value.threads[0].line");
	});
});

describe("GitHub's view", () => {
	const HEAD = "h".repeat(40);
	const page = (nodes: object[]) => ({ pageInfo: { hasNextPage: false }, nodes });
	const github = {
		graphql: async (query: string) =>
			query.includes("isDraft")
				? {
						repository: {
							pullRequest: {
								url: "https://github.com/acme/proj/pull/1",
								title: "Fix",
								body: "Body.",
								state: "MERGED",
								isDraft: false,
								author: null,
							},
						},
					}
				: {
						repository: {
							p1: {
								headRefOid: HEAD,
								commits: { nodes: [{ commit: { oid: HEAD, committedDate: "2026-11-10T17:00:00Z" } }] },
								comments: page([
									{
										author: { login: "maintainer" },
										body: "Why?",
										createdAt: "2026-11-10T18:00:00Z",
										url: "https://github.com/acme/proj/pull/1#issuecomment-1",
									},
								]),
								reviews: page([
									{
										url: "https://github.com/acme/proj/pull/1#pullrequestreview-1",
										state: "CHANGES_REQUESTED",
										author: { __typename: "Bot", login: "pullfrog" },
										body: "",
										submittedAt: "2026-11-10T17:30:00Z",
										commit: { oid: HEAD },
									},
									// The viewer's own unsubmitted review.
									{
										url: "x",
										state: "PENDING",
										author: { login: "me" },
										body: "",
										submittedAt: null,
										commit: null,
									},
								]),
								reviewThreads: page([
									{
										id: "PRRT_1",
										isResolved: false,
										isOutdated: true,
										path: "src/a.ts",
										line: null,
										originalLine: 12,
										comments: page([
											{
												author: { __typename: "Bot", login: "pullfrog" },
												body: "Off by one.",
												createdAt: "2026-11-10T17:30:00Z",
												url: "https://github.com/acme/proj/pull/1#discussion_r1",
											},
										]),
									},
								]),
							},
						},
					},
	} as unknown as GitHub;

	test("reads the PR, its submitted reviews, and its threads as gh pr view shows them", async () => {
		expect(await pullView(github, { owner: "acme", repo: "proj", number: 1 })).toEqual({
			url: "https://github.com/acme/proj/pull/1",
			title: "Fix",
			author: "-",
			state: "merged",
			draft: false,
			body: "Body.",
			comments: [
				{
					author: "maintainer",
					body: "Why?",
					createdAt: "2026-11-10T18:00:00Z",
					url: "https://github.com/acme/proj/pull/1#issuecomment-1",
				},
			],
			reviews: [
				{
					reviewer: "pullfrog",
					state: "changes_requested",
					body: "",
					commit: HEAD,
					submittedAt: "2026-11-10T17:30:00Z",
					url: "https://github.com/acme/proj/pull/1#pullrequestreview-1",
				},
			],
			threads: [
				{
					id: "PRRT_1",
					path: "src/a.ts",
					line: 12,
					outdated: true,
					resolved: false,
					comments: [
						{
							author: "pullfrog",
							body: "Off by one.",
							createdAt: "2026-11-10T17:30:00Z",
							url: "https://github.com/acme/proj/pull/1#discussion_r1",
						},
					],
				},
			],
		});
	});
});
