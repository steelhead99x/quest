// The forge writes on a repository Kixel Quest hosts, through the CLI against a fake Kixel Quest that never lets a
// request reach GitHub, and the wire their requests and answers travel in.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { forgeJson, parseForgeAnswer, parseForgeRequest } from "../src/core";
import { upstream } from "../src/cli/claims";
import { hostedRepository, locate } from "../src/cli/forge";
import { type Output, main } from "../src/cli/main";
import { GitHubWrites } from "../src/cli/writes";
import type { GitHubDependencies } from "../src/github/client";
import { FakeKixelQuest, HEAD, KIXEL, REPOSITORY, kixelEnv } from "./kixel-fakes";
import { tempDir } from "./fixture";

let kixel: FakeKixelQuest;
beforeEach(() => {
	kixel = new FakeKixelQuest();
	for (const [name, value] of Object.entries(kixelEnv())) vi.stubEnv(name, value);
	// A GitHub call fails the test: none is expected, and no token is set to make one.
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

describe("a PR on a repository Kixel Quest hosts", () => {
	test("is edited, commented on, held, readied, has a thread resolved, released, and picked", async () => {
		const pull = kixel.add({
			branch: "quest/m0/one",
			draft: true,
			body: "Claims it.\n\n## Waiting\n\n- Maintainer: pick one.",
			threads: new Map([["thread-1", false]]),
		});
		const url = kixel.url(pull.number);

		expect(
			await cli("pr", "edit", url, "--title", "One", "--body", "Done.\n\n## Waiting\n\n- Maintainer: x"),
		).toEqual({ code: 0, stdout: "", stderr: "" });
		expect([pull.title, pull.body]).toEqual(["One", "Done.\n\n## Waiting\n\n- Maintainer: x"]);

		const iterated = await cli("iterate", url);
		expect(iterated).toEqual({ code: 0, stdout: "hold-1\n", stderr: "" });
		// A second session is refused while the first holds it, and holds nothing.
		const second = await cli("iterate", url);
		expect(second.code).toBe(3);
		expect(second.stderr).toBe(`quest: ${url} is held by quest:active\n`);
		expect(await cli("iterate", url, "hold-1")).toEqual({ code: 0, stdout: "hold-1\n", stderr: "" });

		const reply = await cli("pr", "comment", url, "--thread", "thread-1", "--body", "Fixed in the head.");
		expect(reply).toEqual({ code: 0, stdout: `${url}#comment-1\n`, stderr: "" });
		expect(await cli("pr", "resolve", url, "thread-1")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(pull.threads.get("thread-1")).toBe(true);
		const stray = await cli("pr", "resolve", url, "thread-9");
		expect(stray.code).toBe(3);
		expect(stray.stderr).toContain("thread-9 is not a review thread");

		expect(await cli("ready", url, "hold-1")).toEqual({ code: 0, stdout: "hold-1\n", stderr: "" });
		expect([pull.draft, pull.body]).toEqual([false, "Done."]);

		// A pick waits for the session's own hold to go.
		const held = await cli("merge", url, "--land", HEAD);
		expect(held.code).toBe(3);
		expect(pull.picked).toBeNull();
		expect(await cli("release", url, "hold-1")).toEqual({ code: 0, stdout: "released quest:active\n", stderr: "" });
		expect(await cli("merge", url, "--land", HEAD)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(pull.picked).toBe(HEAD);

		expect(kixel.calls.map(({ call }) => call)).toEqual([
			"edit",
			"hold",
			"hold",
			"hold",
			"comment",
			"resolve",
			"resolve",
			"ready",
			"pick",
			"release",
			"pick",
		]);
	});

	test("a pick names the head the person saw, and one that moved is refused", async () => {
		const pull = kixel.add({ branch: "feature", sha: "b".repeat(40) });
		const moved = await cli("merge", kixel.url(pull.number), "--land", HEAD);
		expect(moved.code).toBe(3);
		expect(moved.stderr).toContain(`head moved to ${"b".repeat(40)}`);
		expect(pull.picked).toBeNull();
		// An uppercase SHA, which `--land` accepts, picks the same head.
		const same = kixel.add({ branch: "other" });
		expect(await cli("merge", kixel.url(same.number), "--land", HEAD.toUpperCase())).toMatchObject({ code: 0 });
		expect(same.picked).toBe(HEAD);
	});

	test.each([["--squash"], ["--rebase"], ["--direct"]])("a pick takes no %s", async (flag) => {
		const pull = kixel.add({ branch: "feature" });
		const out = await cli("merge", kixel.url(pull.number), "--land", HEAD, flag);
		expect(out.code).toBe(2);
		expect(out.stderr).toContain(`takes no ${flag}`);
		expect(kixel.calls).toEqual([]);
	});

	test("ready without a token marks a draft ready only while no session holds it", async () => {
		const pull = kixel.add({ branch: "feature", draft: true, body: "Notes.\n\n## Waiting\n\n- x" });
		const url = kixel.url(pull.number);
		expect(await cli("ready", url)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect([pull.draft, pull.body]).toEqual([false, "Notes.\n\n## Waiting\n\n- x"]);
		pull.hold = { label: "quest:active", token: "hold-9" };
		expect((await cli("ready", url)).code).toBe(3);
	});

	test("a comment reads its body from a file or stdin's file descriptor", async () => {
		const pull = kixel.add({ branch: "feature" });
		const file = join(tempDir(), "body.md");
		writeFileSync(file, "From a file.\n");
		expect((await cli("pr", "comment", kixel.url(pull.number), "--body-file", file)).code).toBe(0);
		expect(pull.comments).toEqual([{ body: "From a file.\n", thread: null }]);
		const neither = await cli("pr", "comment", kixel.url(pull.number));
		expect(neither.code).toBe(2);
		expect(neither.stderr).toContain("pass --body or --body-file");
		const nothing = await cli("pr", "edit", kixel.url(pull.number));
		expect(nothing.code).toBe(2);
	});

	test("a malformed request is a usage error, and a failure names no GitHub override", async () => {
		const pull = kixel.add({ branch: "feature" });
		const url = kixel.url(pull.number);
		const empty = await cli("pr", "comment", url, "--body", "");
		expect(empty.code).toBe(2);
		expect(empty.stderr).toContain("Kixel Quest refused POST /forge/comment, malformed forge request.body");
		kixel.fail = { status: 503, error: "down" };
		const down = await cli("pr", "edit", url, "--title", "x");
		expect(down).toEqual({
			code: 1,
			stdout: "",
			stderr: `quest: Kixel Quest (${KIXEL}) failed POST /forge/edit: HTTP 503, down\n`,
		});
	});

	test("QUEST_FORGE=github cannot reach it, and without a token it names the file to pair one in", async () => {
		const pull = kixel.add({ branch: "feature" });
		vi.stubEnv("QUEST_FORGE", "github");
		const forced = await cli("status", kixel.url(pull.number));
		expect(forced.stderr).toBe("quest: Kixel Quest hosts example/project, so QUEST_FORGE=github cannot reach it\n");
		vi.stubEnv("QUEST_FORGE", "");
		vi.stubEnv("XDG_CONFIG_HOME", tempDir());
		const unpaired = await cli("iterate", kixel.url(pull.number));
		expect(unpaired.code).toBe(1);
		expect(unpaired.stderr).toContain(`Kixel Quest (${KIXEL}) hosts example/project; pair a token with it in`);
		expect(kixel.calls).toEqual([]);
	});
});

describe("where a PR lives", () => {
	const env = { QUEST_KIXEL_URL: KIXEL };

	test("a Kixel Quest PR URL, and a GitHub one", () => {
		expect(locate(`${KIXEL}/example/project/pull/12/`, ".", env)).toEqual({
			pull: { ...REPOSITORY, number: 12 },
			hosted: true,
		});
		expect(locate("https://github.com/example/project/pull/12", ".", env)).toEqual({
			pull: { ...REPOSITORY, number: 12 },
			hosted: false,
		});
		expect(() => locate(`${KIXEL}/example/project/issues/12`, ".", env)).toThrow("expected a Kixel Quest PR URL");
	});

	test("a number in an origin on Kixel Quest", () => {
		const work = tempDir();
		const run = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
		run("init", "-q");
		run("remote", "add", "origin", `${KIXEL}/example/project.git`);
		expect(locate("7", work, env)).toEqual({ pull: { ...REPOSITORY, number: 7 }, hosted: true });
		run("remote", "set-url", "origin", "https://github.com/example/project.git");
		expect(locate("7", work, env)).toEqual({ pull: { ...REPOSITORY, number: 7 }, hosted: false });
	});

	// A rewrite to the other forge's mirror never moves a number's writes there: the configured URL wins.
	test("a number in an origin rewritten to the other forge names the configured one", async () => {
		const work = tempDir();
		const run = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
		run("init", "-q");
		run("remote", "add", "origin", `${KIXEL}/example/project.git`);
		run("config", `url.https://github.com/example/.insteadOf`, `${KIXEL}/example/`);
		expect(locate("7", work, env)).toEqual({ pull: { ...REPOSITORY, number: 7 }, hosted: true });
		const pull = kixel.add({ branch: "feature" });
		// The fake fails the test on any request to GitHub.
		expect(await cli("--root", work, "pr", "comment", String(pull.number), "--body", "Hi")).toMatchObject({
			code: 0,
		});
		expect(kixel.calls.map(({ call }) => call)).toEqual(["comment"]);

		run("remote", "set-url", "origin", "https://github.com/example/project.git");
		run("config", "--unset", `url.https://github.com/example/.insteadOf`);
		run("config", `url.${KIXEL}/example/.insteadOf`, "https://github.com/example/");
		expect(locate("7", work, env)).toEqual({ pull: { ...REPOSITORY, number: 7 }, hosted: false });
	});

	test("a claim's upstream is the configured Kixel Quest repository, never a GitHub mirror a rewrite names", async () => {
		const work = tempDir();
		const run = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
		run("init", "-q", "-b", "main");
		run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
		// git reaches the checkout itself, so the default branch is read without a network.
		run("remote", "add", "origin", work);
		const mirror = "https://github.com/example/project.git";
		const remote = {
			name: "origin",
			configured: { fetch: `${KIXEL}/example/project.git`, push: null },
			used: () => ({ fetch: mirror, push: mirror }),
		};
		const github = () => {
			throw new Error("asked GitHub");
		};
		const found = await upstream(work, remote, {
			github,
			forge: github,
			kixel: { hosted: (url) => hostedRepository(KIXEL, url), forge: github },
			warn: () => undefined,
		});
		expect([found.hosting?.repository, found.github]).toEqual([REPOSITORY, null]);
	});

	test("a remote on Kixel Quest names its repository, with or without credentials or .git", () => {
		for (const url of [
			`${KIXEL}/example/project.git`,
			`${KIXEL}/example/project`,
			"http://agent:secret@localhost:8787/example/project.git/",
		])
			expect(hostedRepository(KIXEL, url)).toEqual(REPOSITORY);
		for (const url of [
			"https://kixel.quest/example/project.git",
			`${KIXEL}/example`,
			`${KIXEL}/example/project/extra`,
			"git@github.com:example/project.git",
		])
			expect(hostedRepository(KIXEL, url)).toBeNull();
		expect(hostedRepository("https://kixel.quest", "https://kixel.quest/kixel-ai/kixel.ai.git")).toEqual({
			owner: "kixel-ai",
			repo: "kixel.ai",
		});
		expect(hostedRepository("https://example.com/kq", "https://example.com/kq/example/project.git")).toEqual(
			REPOSITORY,
		);
		expect(hostedRepository("https://example.com/kq", "https://example.com/example/project.git")).toBeNull();
	});
});

describe("the write wire", () => {
	const pull = { ...REPOSITORY, number: 3 };

	test("requests round-trip, and their parsers refuse what Kixel Quest would", () => {
		const opening = {
			repository: REPOSITORY,
			head: REPOSITORY,
			branch: "quest/m0/one",
			base: "main",
			title: "One",
			body: "",
			draft: true,
		};
		for (const [call, request] of [
			["open", { opening }],
			["edit", { pull, title: null, body: "x" }],
			["comment", { pull, body: "x", thread: null }],
			["hold", { pull, token: null }],
			["pick", { pull, head: HEAD }],
		] as const)
			expect(parseForgeRequest(call, JSON.parse(forgeJson(request)))).toEqual(request);
		expect(() => parseForgeRequest("pick", { pull, head: "abc" })).toThrow("a full commit SHA");
		expect(() => parseForgeRequest("release", { pull, token: "" })).toThrow("a name");
		expect(() => parseForgeRequest("open", { opening: { ...opening, title: "" } })).toThrow("a name");
		expect(() => parseForgeRequest("resolve", { pull, thread: "t", extra: 1 })).toThrow("no such field");
	});

	test("answers parse strictly", () => {
		const hold = { label: "quest:active", token: "hold-1" };
		expect(parseForgeAnswer("ready", { value: null, asOf: null }).value).toBeNull();
		expect(parseForgeAnswer("ready", { value: hold, asOf: null }).value).toEqual(hold);
		expect(() => parseForgeAnswer("close", { value: {}, asOf: null })).toThrow("expected null");
		expect(() => parseForgeAnswer("hold", { value: { label: "quest:active" }, asOf: null })).toThrow(
			"answer.value.token",
		);
	});
});

describe("GitHub's writes", () => {
	/** A GitHub answering `graphql` by the mutation or query it names, recording each request. */
	function github(node: unknown) {
		const requests: { path: string; body: any }[] = [];
		const deps: GitHubDependencies = {
			fetch: async (input, init) => {
				const url = new URL(String(input));
				const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
				requests.push({ path: `${init?.method ?? "GET"} ${url.pathname}`, body });
				if (url.pathname === "/graphql") {
					const query = String(body.query);
					if (query.includes("node(id")) return Response.json({ data: { node } });
					if (query.includes("addPullRequestReviewThreadReply"))
						return Response.json({
							data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/c/1" } } },
						});
					return Response.json({ data: { resolveReviewThread: { thread: { id: "T" } } } });
				}
				// The client lists the comments already there, to tell its own from a repeat's.
				if (url.pathname.endsWith("/comments") && init?.method === undefined) return Response.json([]);
				if (url.pathname.endsWith("/comments"))
					return Response.json({ html_url: "https://github.com/example/project/pull/3#issuecomment-1" });
				return Response.json({});
			},
			now: () => 0,
			sleep: async () => undefined,
			token: "token",
			quota: "fail",
			warn: () => undefined,
		};
		return { writes: new GitHubWrites(deps, async () => []), requests };
	}
	const onPull = {
		__typename: "PullRequestReviewThread",
		pullRequest: { number: 3, repository: { nameWithOwner: "Example/Project" } },
	};

	test("comments on the PR, replies in a thread on it, and resolves it", async () => {
		const { writes, requests } = github(onPull);
		expect(await writes.comment(pull(), { body: "Hi", thread: null })).toBe(
			"https://github.com/example/project/pull/3#issuecomment-1",
		);
		expect(await writes.comment(pull(), { body: "Fixed", thread: "T" })).toBe("https://github.com/c/1");
		await writes.resolve(pull(), "T");
		await writes.edit(pull(), { title: null, body: "New" });
		expect(requests.map(({ path }) => path)).toEqual([
			"GET /repos/example/project/issues/3/comments",
			"POST /repos/example/project/issues/3/comments",
			"POST /graphql",
			"POST /graphql",
			"POST /graphql",
			"POST /graphql",
			"PATCH /repos/example/project/pulls/3",
		]);
		expect(requests.at(-1)!.body).toEqual({ body: "New" });
	});

	test.each([
		["another PR's", { ...onPull, pullRequest: { number: 4, repository: { nameWithOwner: "example/project" } } }],
		["a missing", null],
		["a non-thread", { __typename: "IssueComment" }],
	])("refuses %s thread before writing", async (_, node) => {
		const { writes, requests } = github(node);
		await expect(writes.resolve(pull(), "T")).rejects.toThrow("T is not a review thread on example/project#3");
		expect(requests).toHaveLength(1);
	});

	test("opens a PR from a fork, naming its repository for one owner's two repositories", async () => {
		const { writes, requests } = github(onPull);
		const opening = { repository: REPOSITORY, branch: "b", base: "main", title: "T", body: "", draft: true };
		// The fake answers `{}`, which the PR row's parse refuses; only the request matters here.
		await writes.open({ ...opening, head: { owner: "example", repo: "fork" } }).catch(() => undefined);
		await writes.open({ ...opening, head: REPOSITORY }).catch(() => undefined);
		expect(requests.map(({ body }) => [body.head, body.head_repo])).toEqual([
			["example:b", "example/fork"],
			["b", undefined],
		]);
	});

	function pull() {
		return { ...REPOSITORY, number: 3 };
	}
});
