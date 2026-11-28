// The forge reads answer the same through GitHub and through Kixel Quest. The fake Kixel Quest serves each read by
// running the GitHub backend on a fake GitHub, as its index's fallthrough does, so an answer that differs is the
// wire's doing: a field lost, reordered, or retyped between the two.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
	type Forge,
	type ForgeCall,
	InputError,
	FORGE_CALLS,
	type Holdings,
	type PullRequest,
	forgeJson,
	parseForgeAnswer,
	parseForgeInfo,
	parseForgeRequest,
	REVIEW_MARK,
} from "../src/core";
import { type ForgeDependencies, forgeFor, KixelQuest, KixelQuestForge } from "../src/cli/forge";
import { waitForActivity, WaitTimeout } from "../src/cli/wait";
import { type GitHubReadDependencies } from "../src/github/client";
import { GitHubForge } from "../src/github/forge";
import { tokensPath } from "../src/cli/tokens";
import { writeTokens } from "./kixel-fakes";
import * as status from "./status-fakes";
import * as wait from "./wait-fakes";

const URL_ = "https://kixel.quest";
const TOKEN = "kq-token";
const repository = { owner: "example", repo: "project" };

/** A fake Kixel Quest serving `github`'s answers to the person `login`, at `asOf`. */
function kixelQuest(
	github: () => GitHubReadDependencies,
	options: { login?: string; repositories?: string[]; asOf?: string | null; fail?: number; answer?: unknown } = {},
) {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		requests.push({ method, path: url.pathname, body });
		if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`)
			return Response.json({ error: "This token was never issued here, or it was revoked." }, { status: 401 });
		if (options.fail) return Response.json({ error: "index unavailable" }, { status: options.fail });
		if (method === "GET" && url.pathname === "/forge")
			return Response.json({
				login: options.login ?? "waiter",
				repositories: options.repositories ?? ["example/project"],
			});
		const call = /^\/forge\/(\w+)$/.exec(url.pathname)?.[1] as ForgeCall | undefined;
		if (method !== "POST" || call === undefined || !FORGE_CALLS.includes(call))
			return Response.json({ error: "no such read" }, { status: 404 });
		if (options.answer !== undefined) return Response.json(options.answer);
		const forge = new GitHubForge(github(), options.login ?? "waiter");
		let value: unknown;
		try {
			value = await serve(forge, call, parseForgeRequest(call, body));
		} catch (error) {
			if (error instanceof InputError) return Response.json({ error: error.message }, { status: 400 });
			throw error;
		}
		return new Response(forgeJson({ value, asOf: options.asOf ?? null }), {
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, requests };
}

/** One read, as Kixel Quest's fallthrough answers it. */
async function serve(forge: Forge, call: ForgeCall, request: any): Promise<unknown> {
	switch (call) {
		case "status":
			return (await forge.status(request.pull)).value;
		case "pulls":
			return (await forge.pulls(request.repository)).value;
		case "files":
			return (await forge.files(request.repository)).value;
		case "held":
			return (await forge.held(request.sources, request.branches)).value;
		case "watch":
			return (await forge.watch(request.pull, { since: request.from ?? undefined, deadline: Infinity }).poll())
				.value;
	}
}

let config: string | undefined;
/** What the forge dependencies told the person. */
let warned: string[] = [];
afterEach(() => {
	if (config) rmSync(config, { recursive: true, force: true });
	config = undefined;
	warned = [];
});

/** Forge dependencies whose token file pairs `TOKEN` with Kixel Quest, unless `token` is false. */
function dependencies(
	fetch: ForgeDependencies["fetch"],
	github: () => GitHubReadDependencies,
	env: NodeJS.ProcessEnv = {},
	token = true,
): ForgeDependencies {
	config = mkdtempSync(join(tmpdir(), "quest-forge-"));
	if (token) {
		writeTokens({ XDG_CONFIG_HOME: config }, { [URL_]: TOKEN });
	}
	return {
		env: { XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(config, "cache"), ...env },
		fetch,
		now: () => 0,
		sleep: async () => {},
		// The fake's token is the person's own here.
		github: () => {
			const { readToken, ...rest } = github();
			return { ...rest, token: readToken };
		},
		warn: (line) => warned.push(line),
	};
}

/** Kixel Quest's backend over a fake serving `github`. */
async function throughKixelQuest(github: () => GitHubReadDependencies, options?: Parameters<typeof kixelQuest>[1]) {
	const server = kixelQuest(github, options);
	// Kixel Quest's reads keep the fake GitHub's clock, which a wait's deadline is set by.
	const forge = await forgeFor(repository, { ...dependencies(server.fetch, github), now: () => github().now() });
	expect(forge).toBeInstanceOf(KixelQuestForge);
	return { forge, server };
}

describe("status", () => {
	const scenarios: [string, () => ReturnType<typeof status.setup>][] = [
		[
			"checks, reviews, reactions, and threads",
			() =>
				status.setup(
					[
						status.pull({
							checks: status.page([
								status.run("lint", "COMPLETED", "FAILURE", true),
								status.run("test", "IN_PROGRESS", null, true),
								status.run("build", "COMPLETED", "SUCCESS", true),
								{ __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: null },
							]),
							reviews: status.page([
								status.review("alice", "APPROVED", status.B, 1),
								status.review("alice", "COMMENTED", status.A, 3, [
									{
										content: "THUMBS_UP",
										createdAt: "2026-10-07T12:04:00Z",
										user: { login: "codex[bot]" },
									},
								]),
								status.review("gone", "COMMENTED", null, 5),
							]),
							threads: status.page([
								status.thread("T1", true),
								status.thread("T2", false, null, "author"),
							]),
							reactions: [{ content: "EYES", createdAt: "2026-10-07T12:00:00Z", user: null }],
						}),
					],
					{ runs: [] },
				),
		],
		[
			"a queued draft with auto-merge",
			() =>
				status.setup([
					status.pull({
						isDraft: true,
						reviewDecision: null,
						autoMergeRequest: {
							enabledAt: "2026-10-07T12:00:00Z",
							mergeMethod: "SQUASH",
							enabledBy: { login: "kixelated" },
						},
						mergeQueueEntry: { state: "AWAITING_CHECKS", position: 2, enqueuedAt: "2026-10-07T12:01:00Z" },
						checks: null,
						reviews: status.page([]),
						threads: status.page([]),
					}),
				]),
		],
		...[
			["a malformed risk record", "- Risk:dire"],
			["a risk record", "- Risk: high, `wire`\n- Classified: medium by default\n- Class: `wire`"],
		].map(([name, lines]): (typeof scenarios)[number] => [
			name!,
			() =>
				status.setup([
					status.pull({
						body: `## Review\n\n${REVIEW_MARK}\n\n- Head: ${status.A}\n${lines}`,
						checks: null,
						reviews: status.page([]),
						threads: status.page([]),
					}),
				]),
		]),
		[
			"a maintainer decision and a hold",
			() =>
				status.setup(
					[
						status.pull({
							checks: null,
							reviews: status.page([]),
							threads: status.page([]),
							labels: { nodes: [{ name: "quest:active" }] },
						}),
					],
					{
						now: Date.parse("2026-10-07T12:00:00Z"),
						holdFields: {
							timelineItems: {
								nodes: [
									{
										__typename: "LabeledEvent",
										id: "token",
										createdAt: "2026-10-07T11:00:00Z",
										label: { name: "quest:active" },
									},
								],
							},
						},
						eventPages: [
							{
								rows: [
									{
										node_id: "token",
										event: "labeled",
										label: { name: "quest:active" },
										url: "event-url",
									},
								],
							},
						],
						signals: {
							comments: status.page([
								{
									author: { __typename: "User", login: "kixelated" },
									authorAssociation: "OWNER",
									body: "Maintainer decision: raise the timeout.",
									createdAt: "2026-10-16T01:00:00Z",
									url: `${status.URL_}#issuecomment-9`,
								},
							]),
						},
					},
				),
		],
	];

	test.each(scenarios)("%s reads the same through Kixel Quest as from GitHub", async (_, scenario) => {
		const direct = await new GitHubForge(scenario().deps).status(status.pr);
		const fixture = scenario();
		const { forge } = await throughKixelQuest(() => fixture.deps, { asOf: "2026-10-07T12:10:00Z" });
		const served = await forge.status(status.pr);
		expect(served.value).toEqual(direct.value);
		// `quest status --json` prints the same bytes either way.
		expect(JSON.stringify(served.value)).toBe(JSON.stringify(direct.value));
		expect([direct.asOf, served.asOf]).toEqual([null, "2026-10-07T12:10:00Z"]);
	});
});

/** A fake GitHub holding open PRs and a merged one, as the claim reads list them. */
function claimsGitHub(): GitHubReadDependencies {
	const pull = (number: number, ref: string, extra: Record<string, unknown> = {}) => ({
		number,
		html_url: `https://github.com/example/project/pull/${number}`,
		head: { ref, sha: "c".repeat(40), repo: { full_name: "example/project" } },
		base: { ref: "main" },
		draft: true,
		created_at: `2026-10-0${number}T00:00:00Z`,
		updated_at: `2026-10-0${number}T01:00:00Z`,
		body: number === 2 ? "## Waiting\n\n- Maintainer: pick" : "",
		...extra,
	});
	const open = [pull(1, "quest/m0/one"), pull(2, "quest/m0/two"), pull(3, "feature", { draft: false, body: null })];
	const merged = [pull(4, "quest/m0/done", { head: { ref: "quest/m0/done", sha: "d".repeat(40) }, merged_at: "x" })];
	return {
		readToken: "test-token",
		quota: "fail",
		now: () => 0,
		sleep: async () => {},
		warn: () => {},
		fetch: async (input) => {
			const url = new URL(String(input));
			if (url.pathname !== "/repos/example/project/pulls") throw new Error(`unexpected ${url.pathname}`);
			if (url.searchParams.get("state") === "open") return Response.json(open);
			const head = url.searchParams.get("head");
			return Response.json(merged.filter((row) => `example:${row.head.ref}` === head));
		},
	};
}

test("open PRs and claims read the same through Kixel Quest as from GitHub, landed branches included", async () => {
	const sources = {
		upstream: {
			repository,
			tips: new Map([
				["quest/m0/one", "c".repeat(40)],
				["quest/m0/done", "d".repeat(40)],
				["quest/m0/pushed", "e".repeat(40)],
			]),
		},
	};
	const branches = ["quest/m0/one", "quest/m0/two", "quest/m0/done", "quest/m0/pushed", "quest/m0/free"];
	const github = new GitHubForge(claimsGitHub());
	const { forge, server } = await throughKixelQuest(claimsGitHub);
	expect((await forge.pulls(repository)).value).toEqual((await github.pulls(repository)).value);
	const direct = (await github.held(sources, branches)).value;
	const served = (await forge.held(sources, branches)).value;
	expect(served).toEqual(direct);
	expect(served.claims.map((claim) => claim.branch)).toEqual(["quest/m0/one", "quest/m0/pushed", "quest/m0/two"]);
	expect([...served.landed]).toEqual([["quest/m0/done", "d".repeat(40)]]);
	// The tips git read travel with the request, so Kixel Quest judges the branches the person sees.
	expect(server.requests.find((request) => request.path === "/forge/held")?.body).toMatchObject({
		sources: { upstream: { tips: { "quest/m0/one": "c".repeat(40) } } },
	});
});

describe("wait", () => {
	const scenarios: [string, () => ReturnType<typeof wait.setup>][] = [
		[
			"a review already on the head",
			() =>
				wait.setup([
					wait.pull(),
					wait.response([wait.pushed()]),
					wait.response([wait.committed(wait.A), wait.reviewed()]),
				]),
		],
		[
			"a push found on the third poll",
			() =>
				wait.setup([
					wait.pull(),
					wait.response([wait.pushed()]),
					wait.response([wait.committed(wait.A)]),
					wait.response([wait.committed(wait.A)]),
					wait.response([wait.committed(wait.A), wait.committed(wait.B)]),
				]),
		],
		[
			"the waiter's own reply, then another's",
			() =>
				wait.setup(
					[wait.pull(), wait.response([wait.pushed()]), wait.response([]), wait.response([])],
					[wait.A],
					{
						comments: [
							wait.response([wait.replied(2, wait.POINT, "waiter")]),
							wait.response([wait.replied(2, wait.POINT, "waiter"), wait.replied(3)]),
						],
					},
				),
		],
	];

	test.each(scenarios)("%s wakes the same through Kixel Quest as from GitHub", async (_, scenario) => {
		const direct = scenario();
		const expected = await waitForActivity(
			wait.pr,
			{},
			{ choose: async () => new GitHubForge(direct.deps) },
			direct.deps,
		);
		const fixture = scenario();
		const { forge } = await throughKixelQuest(() => fixture.deps);
		expect(await waitForActivity(wait.pr, {}, { choose: async () => forge }, fixture.deps)).toEqual(expected);
		expect(fixture.sleeps).toEqual(direct.sleeps);
	});

	test("a timeout resumes from Kixel Quest's cursor and says how current its index was", async () => {
		const fixture = wait.setup([wait.pull(), wait.response([wait.pushed()]), wait.response([]), wait.response([])]);
		const { forge } = await throughKixelQuest(() => fixture.deps, { asOf: "2026-10-07T12:09:00Z" });
		const error = await waitForActivity(
			wait.pr,
			{ timeout: 60 },
			{ choose: async () => forge },
			fixture.deps,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WaitTimeout);
		expect((error as WaitTimeout).cursor).toMatch(/^q1\./);
		expect((error as Error).message).toBe(
			"timed out waiting for pull request activity; Kixel Quest's last answer was current to 2026-10-07T12:09:00Z",
		);
	});
	test("a first poll that times out resumes from when the wait started, so a retry reports a push made meanwhile", async () => {
		const first = wait.setup([]);
		const server = kixelQuest(() => first.deps);
		// Asking which forge to read takes 10 seconds, then Kixel Quest never answers the first poll.
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			await first.deps.sleep(new URL(String(input)).pathname === "/forge" ? 10_000 : 61_000);
			if (new URL(String(input)).pathname === "/forge") return server.fetch(input, init);
			throw new Error("The operation timed out.");
		};
		const deps = { ...dependencies(fetch, () => first.deps), now: first.deps.now };
		// The wait starts half a second into 12:10:00, which GitHub times activity in as 12:10:00.
		await first.deps.sleep(500);
		const timeout = await waitForActivity(
			wait.pr,
			{ timeout: 60 },
			{ choose: (pull, deadline) => forgeFor(pull, deps, deadline) },
			first.deps,
		).catch((e: unknown) => e);
		expect(timeout).toBeInstanceOf(WaitTimeout);
		expect((timeout as WaitTimeout).cursor).toBe("2026-10-07T12:10:00.000Z");
		// The head moved to B in the wait's first second; the retry reports that push.
		const second = wait.setup(
			[
				wait.pull(undefined, wait.B),
				wait.response([wait.pushed(wait.B, "2026-10-07T12:10:00Z"), wait.pushed()]),
				wait.response([wait.committed(wait.A), wait.committed(wait.B)]),
			],
			[wait.A, wait.B],
		);
		const retry = await throughKixelQuest(() => second.deps);
		const lines = await waitForActivity(
			wait.pr,
			{ since: (timeout as WaitTimeout).cursor },
			{ choose: async () => retry.forge },
			second.deps,
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^2026-10-07T12:10:00Z pushed author /);
	});
});

describe("wait deadlines and arguments", () => {
	test("the timeout covers asking Kixel Quest which forge to read", async () => {
		const server = kixelQuest(() => wait.setup([]).deps);
		let now = 0;
		// The first reading starts the clock; by the time Kixel Quest would be asked, the timeout has passed.
		const clock = { now: () => (now++ === 0 ? 0 : 20_000), sleep: async () => {} };
		const deps = { ...dependencies(server.fetch, unreachableGitHub), now: clock.now };
		const choice = { choose: (pull: PullRequest, deadline: number) => forgeFor(pull, deps, deadline) };
		const error = await waitForActivity(wait.pr, { timeout: 10 }, choice, clock).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WaitTimeout);
		expect(server.requests).toEqual([]);
	});

	test("a rate-limited viewer read on GitHub gives up at the wait's timeout", async () => {
		const fixture = wait.setup([wait.pull(), wait.response([wait.pushed()]), wait.response([])], [wait.A], {
			viewer: wait.response(
				{ message: "API rate limit exceeded" },
				{
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(Date.parse("2026-10-07T13:10:00Z") / 1000),
				},
				403,
			),
		});
		const error = await wait.waitOn(wait.pr, { timeout: 60 }, fixture.deps).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WaitTimeout);
		expect(fixture.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(60_000);
	});

	test("a viewer or Kixel Quest read that failed is read again, not kept", async () => {
		let viewers = 0;
		const github: GitHubReadDependencies = {
			...claimsGitHub(),
			fetch: async () =>
				++viewers === 1
					? Response.json({ message: "Bad gateway" }, { status: 400 })
					: Response.json({ data: { viewer: { login: "kixelated" } } }),
		};
		const forge = new GitHubForge(github);
		await expect(forge.viewer()).rejects.toThrow("Bad gateway");
		expect(await forge.viewer()).toBe("kixelated");
		expect(await forge.viewer()).toBe("kixelated");
		expect(viewers).toBe(2);
		const server = kixelQuest(unreachableGitHub);
		let now = 0;
		const kixel = new KixelQuest(
			URL_,
			TOKEN,
			{ ...dependencies(server.fetch, unreachableGitHub), now: () => now },
			false,
		);
		now = 10;
		await expect(kixel.info(5)).rejects.toThrow("its deadline passed");
		expect((await kixel.info()).login).toBe("waiter");
		await kixel.info();
		expect(server.requests).toHaveLength(1);
	});

	test("Kixel Quest's refusal of a bad wait point is a usage error, as GitHub's is", async () => {
		const bad = { since: "yesterday" };
		const direct = wait.setup([]);
		await expect(wait.waitOn(wait.pr, bad, direct.deps)).rejects.toBeInstanceOf(InputError);
		const fixture = wait.setup([]);
		const { forge } = await throughKixelQuest(() => fixture.deps);
		const error = await waitForActivity(wait.pr, bad, { choose: async () => forge }, fixture.deps).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(InputError);
		expect((error as Error).message).toMatch(
			/^Kixel Quest refused POST \/forge\/watch, invalid timestamp: yesterday/,
		);
	});
});

const unreachableGitHub = (): GitHubReadDependencies => {
	throw new Error("read GitHub");
};

describe("choosing the forge", () => {
	const unreachable = (): GitHubReadDependencies => {
		throw new Error("read GitHub");
	};

	test("a repository Kixel Quest does not serve reads GitHub", async () => {
		const server = kixelQuest(unreachable);
		const deps = dependencies(server.fetch, claimsGitHub);
		expect(await forgeFor({ owner: "other", repo: "project" }, deps)).toBeInstanceOf(GitHubForge);
		// Kixel Quest names repositories in lowercase; GitHub ignores case.
		expect(await forgeFor({ owner: "Example", repo: "Project" }, deps)).toBeInstanceOf(KixelQuestForge);
	});

	test("without a token, or with QUEST_FORGE=github, reads go to GitHub and never ask Kixel Quest", async () => {
		const server = kixelQuest(unreachable);
		expect(await forgeFor(repository, dependencies(server.fetch, claimsGitHub, {}, false))).toBeInstanceOf(
			GitHubForge,
		);
		expect(warned).toEqual([]);
		const forced = await forgeFor(repository, dependencies(server.fetch, claimsGitHub, { QUEST_FORGE: "github" }));
		expect(forced).toBeInstanceOf(GitHubForge);
		expect(server.requests).toEqual([]);
		// With a token, reads would have asked Kixel Quest, so the override says what it costs.
		expect(warned).toEqual([
			`QUEST_FORGE=github spends your GitHub quota on reads Kixel Quest (${URL_}) may serve; set it only to rerun a command Kixel Quest failed`,
		]);
		// A token file or URL that does not read is what the override gets past, so it still reads GitHub.
		warned = [];
		const broken = dependencies(server.fetch, claimsGitHub, { QUEST_FORGE: "github" });
		writeFileSync(tokensPath({ XDG_CONFIG_HOME: config! }), "{");
		expect(await forgeFor(repository, broken)).toBeInstanceOf(GitHubForge);
		const elsewhere = { QUEST_FORGE: "github", QUEST_KIXEL_URL: "http://example.com" };
		expect(await forgeFor(repository, dependencies(server.fetch, claimsGitHub, elsewhere))).toBeInstanceOf(
			GitHubForge,
		);
		expect(warned).toEqual([]);
		await expect(
			forgeFor(repository, dependencies(server.fetch, claimsGitHub, { QUEST_FORGE: "gitlab" })),
		).rejects.toThrow("QUEST_FORGE is gitlab; set it to github to read GitHub, or leave it unset");
	});

	test("QUEST_KIXEL_URL names another Kixel Quest, whose own token the file pairs with it", async () => {
		const server = kixelQuest(unreachable);
		const deps = dependencies(server.fetch, unreachable, { QUEST_KIXEL_URL: "http://localhost:8787" });
		// The token file pairs the token with kixel.quest only, so the local one gets none and reads go to GitHub.
		await expect(forgeFor(repository, deps)).rejects.toThrow("read GitHub");
		writeTokens({ XDG_CONFIG_HOME: config! }, { "http://localhost:8787": TOKEN });
		expect(await forgeFor(repository, deps)).toBeInstanceOf(KixelQuestForge);
		expect(server.requests.map((request) => new URL(request.path, "http://localhost:8787").pathname)).toEqual([
			"/forge",
		]);
		await expect(
			forgeFor(repository, { ...deps, env: { ...deps.env, QUEST_KIXEL_URL: "http://example.com" } }),
		).rejects.toThrow("not an HTTPS URL");
	});

	test("a Kixel Quest error fails the read, naming the setting that reads GitHub", async () => {
		const override =
			"rerun this command with QUEST_FORGE=github; leave it unset otherwise, since it spends your GitHub quota";
		const down = kixelQuest(unreachable, { fail: 503 });
		await expect(forgeFor(repository, dependencies(down.fetch, unreachable))).rejects.toThrow(
			`Kixel Quest (${URL_}) failed GET /forge: HTTP 503, index unavailable; ${override}`,
		);
		const refused = kixelQuest(unreachable);
		const deps = dependencies(refused.fetch, unreachable);
		writeTokens({ XDG_CONFIG_HOME: config! }, { [URL_]: "revoked" });
		await expect(forgeFor(repository, deps)).rejects.toThrow(`it refused the token`);
		await expect(forgeFor(repository, deps)).rejects.toThrow(override);
		const malformed = kixelQuest(unreachable, { answer: { value: [{ number: 1 }], asOf: null } });
		const forge = await forgeFor(repository, dependencies(malformed.fetch, unreachable));
		await expect(forge.pulls(repository)).rejects.toThrow(
			`Kixel Quest (${URL_}) failed POST /forge/pulls: malformed forge answer.value[0].url: expected a value; ${override}`,
		);
	});

	test("a Kixel Quest 400 on a read without a free-form argument names the setting that reads GitHub", async () => {
		const server = kixelQuest(unreachable, { fail: 400 });
		const kixel = new KixelQuest(URL_, TOKEN, dependencies(server.fetch, unreachable), false);
		const error = await new KixelQuestForge(kixel).pulls(repository).catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(InputError);
		expect((error as Error).message).toBe(
			`Kixel Quest (${URL_}) failed POST /forge/pulls: HTTP 400, index unavailable; rerun this command with QUEST_FORGE=github; leave it unset otherwise, since it spends your GitHub quota`,
		);
	});

	test("a 429 fails the read, naming its Retry-After in seconds or as a date, and nothing when it has none", async () => {
		const limited = (retryAfter: string | null) =>
			new KixelQuestForge(
				new KixelQuest(
					URL_,
					TOKEN,
					dependencies(
						async () =>
							Response.json(
								{ error: "read budget spent" },
								{ status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } },
							),
						unreachable,
					),
					false,
				),
			);
		const message = (wait: string) =>
			`Kixel Quest (${URL_}) failed POST /forge/pulls: it is rate limiting your requests (HTTP 429, read budget spent)${wait}; rerun this command with QUEST_FORGE=github; leave it unset otherwise, since it spends your GitHub quota`;
		// The dependencies' clock reads 0, the epoch.
		for (const [header, wait] of [
			["90", "; try again in 90 seconds"],
			[new Date(120_000).toUTCString(), "; try again in 120 seconds"],
			// A date already past still says to wait, since the forge refused this read.
			[new Date(0).toUTCString(), "; try again in 1 second"],
			["soon", ""],
			[null, ""],
		] as const)
			await expect(limited(header).pulls(repository)).rejects.toThrow(message(wait));
	});

	test("the person is the token's, not the reading credential's", async () => {
		const server = kixelQuest(unreachable, { login: "kixelated" });
		const forge = new KixelQuestForge(new KixelQuest(URL_, TOKEN, dependencies(server.fetch, unreachable), false));
		expect(await forge.viewer()).toBe("kixelated");
		expect(await new GitHubForge(claimsGitHub(), "kixelated").viewer()).toBe("kixelated");
	});
});

describe("wire", () => {
	const pull: PullRequest = { owner: "example", repo: "project", number: 7 };
	/** A `quest status` answer in the shape Kixel Quest sent before its pin reached #868. */
	const statusBefore868 = () =>
		JSON.parse(readFileSync(new URL("./fixtures/status-before-868.json", import.meta.url), "utf8"));

	test("requests and answers round-trip, maps included", () => {
		const holdings: Holdings = {
			claims: [{ branch: "quest/m0/one", url: null, pull: null }],
			landed: new Map([["quest/m0/done", "d".repeat(40)]]),
		};
		const sources = { upstream: { repository, tips: new Map([["quest/m0/one", "c".repeat(40)]]) } };
		expect(parseForgeRequest("held", JSON.parse(forgeJson({ sources, branches: ["quest/m0/one"] })))).toEqual({
			sources,
			branches: ["quest/m0/one"],
		});
		expect(parseForgeAnswer("held", JSON.parse(forgeJson({ value: holdings, asOf: null })))).toEqual({
			value: holdings,
			asOf: null,
		});
		expect(parseForgeRequest("watch", { pull, from: null })).toEqual({ pull, from: null });
		expect(parseForgeInfo({ login: "kixelated", repositories: ["moq-dev/quest"] })).toEqual({
			login: "kixelated",
			repositories: ["moq-dev/quest"],
		});
	});

	test("anything missing or ill-typed is refused whole, and so is a request's unknown field", () => {
		expect(() => parseForgeRequest("status", { pull: { ...pull, number: 0 } })).toThrow("request.pull.number");
		expect(() => parseForgeRequest("status", { pull, extra: 1 })).toThrow("request.extra: expected no such field");
		// Strict at every depth, as a pick's head would be dropped there too.
		expect(() => parseForgeRequest("pick", { pull: { ...pull, base: "main" }, head: "a".repeat(40) })).toThrow(
			"request.pull.base: expected no such field",
		);
		expect(() => parseForgeRequest("held", { sources: { upstream: { repository } }, branches: ["main"] })).toThrow(
			"request.branches[0]: expected a quest branch",
		);
		expect(() =>
			parseForgeAnswer("held", { value: { claims: [], landed: { "quest/m0/a": "short" } }, asOf: null }),
		).toThrow("answer.value.landed.quest/m0/a: expected a full commit SHA");
		expect(() => parseForgeAnswer("watch", { value: { events: [], cursor: "q1.x" }, asOf: null })).toThrow(
			"answer.value.pollInterval: expected a value",
		);
		expect(() => parseForgeAnswer("pulls", { value: [], asOf: "yesterday" })).toThrow("answer.asOf");
		expect(() => parseForgeInfo({ login: "kixelated", repositories: ["Moq-Dev/Quest"] })).toThrow(
			"lowercase owner/repo",
		);
	});

	test("the writers read takes a PR and answers each writer, refusing a missing field or a cost that is no number", () => {
		const writer = {
			harness: "claude",
			model: "claude-opus-5-5",
			effort: "high",
			arm: "A",
			cost: 1.5,
			complete: true,
		};
		const unrecorded = { harness: "claude", model: null, effort: null, arm: null, cost: 0.25, complete: false };
		expect(parseForgeRequest("writers", { pull })).toEqual({ pull });
		expect(() => parseForgeRequest("writers", { pull, extra: 1 })).toThrow("request.extra");
		expect(parseForgeAnswer("writers", { value: [writer, unrecorded], asOf: null })).toEqual({
			value: [writer, unrecorded],
			asOf: null,
		});
		expect(parseForgeAnswer("writers", { value: [], asOf: null }).value).toEqual([]);
		for (const field of Object.keys(writer))
			expect(() =>
				parseForgeAnswer("writers", { value: [{ ...writer, [field]: undefined }], asOf: null }),
			).toThrow(`answer.value[0].${field}`);
		for (const cost of ["1.5", null, Number.NaN, Number.POSITIVE_INFINITY, -1])
			expect(() => parseForgeAnswer("writers", { value: [{ ...writer, cost }], asOf: null })).toThrow(
				"answer.value[0].cost: expected a cost",
			);
	});

	test("the updated PRs read takes a first and a last page, and refuses a PR missing a field", () => {
		const merged = {
			number: 7,
			url: "https://kixel.quest/example/project/pull/7",
			branch: "quest/m0/one",
			state: "merged",
			created: 1_000,
			updated: 5_000,
			closed: 4_000,
			body: "## Caused by\n",
		};
		const request = { repository, since: 0, cursor: null };
		expect(parseForgeRequest("updated", request)).toEqual(request);
		expect(parseForgeRequest("updated", { ...request, cursor: "p2" }).cursor).toBe("p2");
		expect(() => parseForgeRequest("updated", { repository, since: 0 })).toThrow("request.cursor");
		expect(() => parseForgeRequest("updated", { ...request, since: -1 })).toThrow("request.since");
		expect(parseForgeAnswer("updated", { value: { pulls: [merged], next: "p2" }, asOf: null }).value.next).toBe(
			"p2",
		);
		const last = parseForgeAnswer("updated", {
			value: { pulls: [merged, { ...merged, number: 8 }], next: null },
			asOf: null,
		});
		expect(last.value).toEqual({ pulls: [merged, { ...merged, number: 8 }], next: null });
		for (const field of Object.keys(merged))
			expect(() =>
				parseForgeAnswer("updated", {
					value: { pulls: [{ ...merged, [field]: undefined }], next: null },
					asOf: null,
				}),
			).toThrow(`answer.value.pulls[0].${field}`);
		const open = { ...merged, state: "open", closed: null };
		expect(parseForgeAnswer("updated", { value: { pulls: [open], next: null }, asOf: null }).value.pulls).toEqual([
			open,
		]);
		expect(() =>
			parseForgeAnswer("updated", { value: { pulls: [{ ...merged, state: "draft" }], next: null }, asOf: null }),
		).toThrow("answer.value.pulls[0].state");
		expect(() => parseForgeAnswer("updated", { value: { pulls: [] }, asOf: null })).toThrow("answer.value.next");
	});

	test("an answer from a server older than the client reads, each later field failing closed", () => {
		// Clients rejected this on 2026-11-25, as it has no `localReview`.
		const older = statusBefore868();
		const { value } = parseForgeAnswer("status", older);
		// That server counted records no maintainer attests, so neither the record nor its risk counts.
		expect(value.reviewRecord).toBeNull();
		expect(value.risk).toBeNull();
		expect(value.checks).toEqual(older.value.checks);
		// A malformed risk stays, as `quest merge` refuses it.
		const malformed = { state: "malformed", error: "no tier" };
		expect(parseForgeAnswer("status", { ...older, value: { ...older.value, risk: malformed } }).value.risk).toEqual(
			malformed,
		);
		// An attested record reads as sent, and a risk without a class, as servers older than #802 sent, is in none.
		const attested = { ...older.value, reviewRecord: { ...older.value.reviewRecord, localReview: true } };
		expect(parseForgeAnswer("status", { ...older, value: attested }).value).toMatchObject({
			reviewRecord: attested.reviewRecord,
			risk: older.value.risk,
		});
		const { class: _, ...unclassed } = older.value.risk;
		const risk = parseForgeAnswer("status", { ...older, value: { ...attested, risk: unclassed } }).value.risk;
		expect(risk).toEqual({ ...unclassed, class: null });
		// A field that has no default is still required.
		const { head: __, ...headless } = attested.reviewRecord;
		expect(() => parseForgeAnswer("status", { ...older, value: { ...attested, reviewRecord: headless } })).toThrow(
			"answer.value.reviewRecord.head: expected a value",
		);
	});

	test("an answer from a server newer than the client drops the fields it does not know, at any depth", () => {
		const older = statusBefore868();
		const current = {
			...older,
			value: { ...older.value, reviewRecord: { ...older.value.reviewRecord, localReview: false } },
		};
		const known = parseForgeAnswer("status", current);
		const newer = {
			...current,
			served: "index",
			value: {
				...current.value,
				merged: null,
				reviewRecord: { ...current.value.reviewRecord, round: 3 },
				checks: { ...current.value.checks, skipped: 1 },
			},
		};
		expect(parseForgeAnswer("status", newer)).toEqual(known);
		expect(parseForgeInfo({ login: "kixelated", repositories: ["moq-dev/quest"], plan: "free" })).toEqual({
			login: "kixelated",
			repositories: ["moq-dev/quest"],
		});
	});
});
