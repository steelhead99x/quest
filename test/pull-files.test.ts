// `quest pr list`: each open PR's changed paths, read from a fake Kixel Quest that never lets a request reach GitHub,
// from GitHub's GraphQL and REST answers, and the wire they travel in.
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type PullFiles, forgeJson, parseForgeAnswer, parseForgeRequest } from "../src/core";
import { type Output, main } from "../src/cli/main";
import type { GitHub } from "../src/github/client";
import { openPullFiles } from "../src/github/files";
import { Tree, tempDir, template } from "./fixture";
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

/** A bare repository with a default branch, which a checkout reads from the Kixel Quest URL it routes there. */
const hostedBare = template((dir) => {
	execFileSync("git", ["clone", "-q", "--bare", Tree.committed().path, "."], { cwd: dir, stdio: "ignore" });
});

/** A checkout whose origin is `url`, fetched from `bare` when given, as Kixel Quest's repository is. */
function checkout(url: string, bare?: string): string {
	const work = tempDir();
	const run = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
	run("init", "-q");
	run("remote", "add", "origin", url);
	if (bare) run("config", `url.${bare}.insteadOf`, url);
	return work;
}

describe("quest pr list on a repository Kixel Quest hosts", () => {
	test("prints a file line per path of each open PR, and --json every PR", async () => {
		const work = checkout(`${KIXEL}/example/project.git`, hostedBare());
		const one = kixel.add({ branch: "quest/m0/one", files: ["quest/m0/one.md", "src/a file.ts"] });
		kixel.add({ branch: "closed", state: "closed", files: ["src/closed.ts"] });
		const empty = kixel.add({ branch: "empty" });
		const two = kixel.add({ branch: "two", files: ["src/b.ts"] });

		const plain = await cli("--root", work, "pr", "list");
		expect(plain).toEqual({
			code: 0,
			stdout: [
				`file ${kixel.url(one.number)} quest/m0/one.md`,
				`file ${kixel.url(one.number)} src/a file.ts`,
				`file ${kixel.url(two.number)} src/b.ts`,
				"",
			].join("\n"),
			stderr: "",
		});

		const json = await cli("--root", work, "pr", "list", "--json");
		expect(JSON.parse(json.stdout)).toEqual([
			{ number: one.number, url: kixel.url(one.number), files: ["quest/m0/one.md", "src/a file.ts"] },
			{ number: empty.number, url: kixel.url(empty.number), files: [] },
			{ number: two.number, url: kixel.url(two.number), files: ["src/b.ts"] },
		]);
		expect(kixel.calls.map(({ call }) => call)).toEqual(["files", "files"]);
	});

	test("a failure fails the command, and nothing reaches GitHub", async () => {
		const work = checkout(`${KIXEL}/example/project.git`, hostedBare());
		kixel.fail = { status: 503, error: "down", call: "files" };
		expect(await cli("--root", work, "pr", "list")).toEqual({
			code: 1,
			stdout: "",
			stderr: `quest: Kixel Quest (${KIXEL}) failed POST /forge/files: HTTP 503, down\n`,
		});
	});

	test("outside a checkout, or with an origin on neither forge, fails", async () => {
		expect((await cli("--root", tempDir(), "pr", "list")).code).toBe(1);
		const elsewhere = checkout("https://example.com/example/project.git");
		expect((await cli("--root", elsewhere, "pr", "list")).stderr).toContain("neither a github.com repository");
	});
});

describe("quest pr list in a fork on GitHub", () => {
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
	const info = (full: string, extra: object = {}) => {
		const [owner, repo] = full.split("/");
		return {
			owner: { login: owner },
			name: repo,
			default_branch: "main",
			clone_url: `https://github.com/${full}.git`,
			ssh_url: `git@github.com:${full}.git`,
			fork: false,
			...extra,
		};
	};

	test("lists the parent's PRs, not the fork's, while the parent keeps quests", async () => {
		vi.stubEnv("GH_TOKEN", "token");
		vi.stubEnv("XDG_CACHE_HOME", tempDir());
		const asked: string[] = [];
		vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit & { body?: string }) => {
			const url = new URL(input);
			// Kixel Quest does not serve this repository, so the person's own token reads it.
			if (url.origin === KIXEL) return kixel.fetch(input, init);
			asked.push(url.pathname);
			if (url.pathname === "/repos/me/project")
				return json(info("me/project", { fork: true, parent: info("example/project") }));
			if (url.pathname === "/repos/example/project") return json(info("example/project"));
			if (url.pathname === "/repos/example/project/contents/quest/README.md") return json({});
			if (url.pathname === "/graphql") {
				const { variables } = JSON.parse(init!.body!) as { variables: { owner: string; repo: string } };
				asked.push(`graphql ${variables.owner}/${variables.repo}`);
				const nodes =
					variables.owner === "example"
						? [
								{
									number: 7,
									url: "https://github.com/example/project/pull/7",
									headRefOid: "h".repeat(40),
									files: {
										pageInfo: { hasNextPage: false },
										nodes: [{ path: "quest/m0/a.md", changeType: "ADDED" }],
									},
								},
							]
						: [];
				return json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } });
			}
			throw new Error(`unexpected request ${url.pathname}`);
		});
		const work = checkout("https://github.com/me/project.git");

		expect(await cli("--root", work, "pr", "list")).toEqual({
			code: 0,
			stdout: "file https://github.com/example/project/pull/7 quest/m0/a.md\n",
			stderr: "",
		});
		expect(asked).toContain("graphql example/project");
		expect(asked).not.toContain("graphql me/project");
		expect(kixel.requests).toEqual(["GET /forge"]);
	});

	test("reads files through the Kixel Quest serving the upstream, never GitHub's lists or a minted token", async () => {
		vi.stubEnv("GH_TOKEN", "token");
		kixel.served = ["example/project"];
		const pull = kixel.add({ branch: "quest/m0/a", files: ["quest/m0/a.md"] });
		const asked: string[] = [];
		vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
			const url = new URL(input);
			if (url.origin === KIXEL) return kixel.fetch(input, init);
			asked.push(url.pathname);
			if (url.pathname === "/repos/example/project") return json(info("example/project"));
			if (url.pathname === "/repos/example/project/contents/quest/README.md") return json({});
			throw new Error(`unexpected request ${url.pathname}`);
		});
		const work = checkout("https://github.com/example/project.git");

		expect(await cli("--root", work, "pr", "list")).toEqual({
			code: 0,
			stdout: `file ${kixel.url(pull.number)} quest/m0/a.md\n`,
			stderr: "",
		});
		expect(kixel.requests).toEqual(["GET /forge", "POST /forge/files"]);
		expect(asked).toEqual(["/repos/example/project"]);
	});
});

describe("the files wire", () => {
	const pulls: PullFiles[] = [{ number: 3, url: "u", files: ["a", "b/c"] }];

	test("round-trips, and refuses what Kixel Quest would", () => {
		expect(parseForgeRequest("files", JSON.parse(forgeJson({ repository: REPOSITORY })))).toEqual({
			repository: REPOSITORY,
		});
		expect(parseForgeAnswer("files", JSON.parse(forgeJson({ value: pulls, asOf: null }))).value).toEqual(pulls);
		expect(() => parseForgeAnswer("files", { value: [{ ...pulls[0], files: [""] }], asOf: null })).toThrow(
			"answer.value[0].files[0]",
		);
		expect(() => parseForgeRequest("files", { repository: REPOSITORY, state: "open" })).toThrow("no such field");
	});
});

describe("GitHub's files", () => {
	const node = (number: number, files: [string, string][], more = false) => ({
		number,
		url: `https://github.com/acme/proj/pull/${number}`,
		headRefOid: "h".repeat(40),
		files: {
			pageInfo: { hasNextPage: more },
			nodes: files.map(([path, changeType]) => ({ path, changeType })),
		},
	});

	test("lists every open PR's paths by number, past GraphQL's 100 files through REST, and across pages", async () => {
		const requests: string[] = [];
		const github = {
			graphql: async (_query: string, variables: { after: string | null }) => {
				requests.push(`graphql ${variables.after}`);
				const first = variables.after === null;
				return {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: first, endCursor: first ? "next" : null },
							nodes: first
								? [node(9, [["src/z.ts", "MODIFIED"]]), node(2, [["quest/m0/a.md", "ADDED"]], true)]
								: [node(5, [["README.md", "DELETED"]])],
						},
					},
				};
			},
			all: async (path: string) => {
				requests.push(path);
				return [
					{ filename: "quest/m0/a.md", status: "added" },
					{ filename: "src/renamed.ts", status: "renamed" },
				];
			},
		} as unknown as GitHub;

		expect(await openPullFiles(github, { owner: "acme", repo: "proj" })).toEqual([
			{
				number: 2,
				url: "https://github.com/acme/proj/pull/2",
				files: ["quest/m0/a.md", "src/renamed.ts"],
			},
			{ number: 5, url: "https://github.com/acme/proj/pull/5", files: ["README.md"] },
			{ number: 9, url: "https://github.com/acme/proj/pull/9", files: ["src/z.ts"] },
		]);
		expect(requests).toEqual(["graphql null", "/repos/acme/proj/pulls/2/files?per_page=100", "graphql next"]);
	});

	test("a PR GitHub's REST cap may have cut fails", async () => {
		const github = {
			graphql: async () => ({
				repository: {
					pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(4, [["a", "ADDED"]], true)] },
				},
			}),
			all: async () => Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}`, status: "added" })),
		} as unknown as GitHub;
		await expect(openPullFiles(github, { owner: "acme", repo: "proj" })).rejects.toThrow(
			"PR #4 changes at least 3000 files, more than GitHub lists",
		);
	});

	test("a repository the token cannot read fails", async () => {
		const github = { graphql: async () => ({ repository: null }) } as unknown as GitHub;
		await expect(openPullFiles(github, { owner: "acme", repo: "proj" })).rejects.toThrow(
			"cannot read acme/proj; check the repository and token",
		);
	});
});
