import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE, parseUpload } from "../src/core";
import { hook } from "../src/cli/hooks";
import {
	type Pending,
	type SendDependencies,
	parseInstant,
	queue,
	reportIncident,
	runSender,
	sendPass,
} from "../src/cli/send";
import { tokensPath } from "../src/cli/tokens";
import type { Session } from "../src/cli/usage";
import { tempDir } from "./fixture";

/** The Kixel Quest the tests' users hold a token for, as `QUEST_KIXEL_URL` names it, and where it takes records. */
const URL_ = "https://kixel.example";
const ENDPOINT = `${URL_}/records`;

/** A checkout that uses Quest, with a GitHub origin. */
function checkout(): string {
	const dir = tempDir();
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/proj.git"]);
	writeFileSync(join(dir, "AGENTS.md"), `${REFERENCE_LINE}\n`);
	return dir;
}

/** A user's state and config, with a token for `URL_` unless told otherwise, and a sender running. */
function home(token: string | null = "secret"): NodeJS.ProcessEnv {
	const env = { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), QUEST_KIXEL_URL: URL_ };
	mkdirSync(join(env.XDG_STATE_HOME, "quest", "records"), { recursive: true });
	writeFileSync(senderPid(env), String(process.pid));
	if (token !== null) {
		mkdirSync(join(env.XDG_CONFIG_HOME, "quest"));
		writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: token }));
	}
	return env;
}

function transcript(): string {
	const path = join(tempDir(), "s.jsonl");
	writeFileSync(path, `{"type":"summary"}\n{"type":"user","timestamp":"2026-11-06T10:00:00Z"}\n`);
	return path;
}

const senderPid = (env: NodeJS.ProcessEnv) => join(env.XDG_STATE_HOME!, "quest", "records", "sender.pid");

const stopped = (cwd: string) => ({ harness: "claude", session: "s1", transcript: transcript(), cwd });

test("a user without a token queues nothing and is told once", () => {
	const env = home(null);
	const root = checkout();
	expect(queue(stopped(root), env).notices).toEqual([expect.stringContaining(`holds no token for ${URL_}`)]);
	expect(queue(stopped(root), env)).toEqual({ notices: [], queued: false });
	// Outside a checkout that uses Quest, nothing is said.
	expect(queue(stopped(tempDir()), env)).toEqual({ notices: [], queued: false });
});

test("the Kixel Quest URL defaults to kixel.quest, and must be HTTPS, or HTTP to this host", () => {
	const root = checkout();
	const env = home(null);
	delete env.QUEST_KIXEL_URL;
	expect(queue(stopped(root), env).notices).toEqual([
		expect.stringContaining("holds no token for https://kixel.quest"),
	]);
	expect(() => queue(stopped(root), { ...env, QUEST_KIXEL_URL: "http://kixel.example" })).toThrow("not an HTTPS URL");
	expect(() => queue(stopped(root), { ...env, QUEST_KIXEL_URL: "kixel" })).toThrow("not a URL");
	// A trailing slash names the same Kixel Quest, so the token pairs with it.
	expect(queue(stopped(root), { ...env, QUEST_KIXEL_URL: "http://127.0.0.1:8080/" }).notices).toEqual([
		expect.stringContaining("holds no token for http://127.0.0.1:8080,"),
	]);
});

/** A token-max session in acme/proj on `branch`. */
const session = (id: string, branch: string, extra: Partial<Session> = {}): Session => ({
	host: null,
	harness: "claude",
	id,
	parent: null,
	review: false,
	cwd: "/w",
	repositories: ["acme/proj"],
	branches: [{ name: branch, first: Date.parse("2026-11-06T10:00:00Z"), last: Date.parse("2026-11-06T10:30:00Z") }],
	start: Date.parse("2026-11-06T10:00:00Z"),
	end: Date.parse("2026-11-06T11:00:00Z"),
	models: [{ model: "m", effort: "high", input: 1, cacheWrite: 0, cacheRead: 0, output: 1, cost: 2, complete: true }],
	cost: 2,
	complete: true,
	skippedLines: 0,
	files: [],
	...extra,
});

/** One user's clock, shared by every sender built for it, so a test moves time across passes. */
const clocks = new WeakMap<NodeJS.ProcessEnv, { now: number }>();
function clockOf(env: NodeJS.ProcessEnv): { now: number } {
	if (!clocks.has(env)) clocks.set(env, { now: Date.parse("2026-11-06T12:00:00Z") });
	return clocks.get(env)!;
}

/** Sender dependencies whose endpoint answers `status`, recording each upload and token-max's window. */
function sender(
	env: NodeJS.ProcessEnv,
	status: number | (() => number),
	sessions: Session[] | null,
	during: () => void = () => {},
	pulls: object[] = [],
	served: string[] = ["acme/proj"],
) {
	const uploads: { token: string; body: unknown }[] = [];
	const asked: string[] = [];
	const windows: Date[] = [];
	const slept: number[] = [];
	const clock = clockOf(env);
	const json = (value: unknown) =>
		new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
	const github = async (input: string | URL | Request) => {
		const url = new URL(String(input));
		// A transferred repository: GitHub redirects its former name to the current one.
		const named = /^\/repos\/(?:acme|old)\/(proj|other)$/.exec(url.pathname)?.[1];
		if (named)
			return json({
				owner: { login: "acme" },
				name: named,
				default_branch: "main",
				clone_url: `https://github.com/acme/${named}.git`,
				ssh_url: `git@github.com:acme/${named}.git`,
				fork: false,
			});
		if (url.pathname === "/repos/acme/other/pulls") return json([]);
		if (url.pathname === "/repos/acme/proj/pulls/3") return json(CULPRIT);
		if (url.pathname === "/repos/acme/proj/pulls")
			return json([
				...pulls,
				{
					number: 7,
					html_url: "https://github.com/acme/proj/pull/7",
					title: "A",
					head: { ref: "quest/m0/a", repo: { full_name: "acme/proj" } },
					state: "open",
					draft: true,
					merged_at: null,
					created_at: "2026-11-06T10:10:00Z",
					updated_at: "2026-11-06T11:00:00Z",
					closed_at: null,
					body: "",
				},
			]);
		return new Response("not found", { status: 404 });
	};
	const deps: SendDependencies = {
		env,
		github: () => ({
			fetch: github as typeof fetch,
			now: Date.now,
			sleep: async () => {},
			token: "t",
			quota: "wait",
			warn: () => {},
		}),
		sessions: (since) => {
			windows.push(since);
			return sessions;
		},
		waits: () => [],
		calls: () => [],
		ask: async () => {
			throw new Error("no model can label here");
		},
		now: () => clock.now,
		sleep: async (ms) => {
			slept.push(ms);
			clock.now += ms;
		},
		interval: 60_000,
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			// Kixel Quest says which repositories it serves, at GET /forge, before anything is posted.
			if (String(input) === `${URL_}/forge`) {
				expect(init?.method).toBe("GET");
				asked.push(String((init?.headers as Record<string, string>).Authorization));
				return json({ login: "me", repositories: served });
			}
			expect(String(input)).toBe(ENDPOINT);
			// A redirect must reach the sender, never be followed into a GET.
			expect(init?.redirect).toBe("manual");
			uploads.push({
				token: String((init?.headers as Record<string, string>).authorization),
				body: JSON.parse(String(init?.body)),
			});
			during();
			const code = typeof status === "number" ? status : status();
			return code >= 300 && code < 400
				? new Response(null, { status: code, headers: { location: "https://records.example/login" } })
				: new Response("", { status: code });
		}) as typeof fetch,
	};
	return { deps, uploads, asked, windows, slept, clock };
}

/** A merged PR older than any window, which later PRs name as a culprit. */
const CULPRIT = {
	number: 3,
	html_url: "https://github.com/acme/proj/pull/3",
	title: "C",
	head: { ref: "quest/m0/c", repo: { full_name: "acme/proj" } },
	state: "closed",
	draft: false,
	merged_at: "2026-10-01T00:00:00Z",
	created_at: "2026-09-30T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
	closed_at: "2026-10-01T00:00:00Z",
	body: "## Models\n\n- Size: M\n- Implementer: Claude Code, claude-opus-5-5, medium effort\n",
};

const pending = (env: NodeJS.ProcessEnv) => readdirSync(join(env.XDG_STATE_HOME!, "quest", "records", "pending"));

test("the sender posts each queued session with its sub-agents, from its transcript's start", async () => {
	const env = home();
	const root = checkout();
	expect(queue(stopped(root), env)).toEqual({ notices: [], queued: true });
	const sessions = [
		session("s1", "quest/m0/a"),
		session("sub", "quest/m0/a", { parent: "s1" }),
		session("other", "quest/m0/a"),
	];
	const { deps, uploads, windows } = sender(env, 200, sessions);
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 2, breakages: 0, refused: false },
	]);
	expect(windows).toEqual([new Date("2026-11-06T10:00:00Z")]);
	expect(uploads).toHaveLength(1);
	expect(uploads[0]!.token).toBe("Bearer secret");
	const { records } = parseUpload(uploads[0]!.body);
	expect(records.map((r) => [r.session, r.pulls, r.role, r.quest])).toEqual([
		["s1", [7], "implementing", "quest/m0/a.md"],
		["sub", [7], "implementing", "quest/m0/a.md"],
	]);
	expect(pending(env)).toEqual([]);
});

test("a session `quest review` queued is sent on the PR it recorded on, as the role it played", async () => {
	const env = home();
	const root = checkout();
	const start = Date.parse("2026-11-06T10:00:00Z");
	const reviewed = (session: string, pull: string | null, branch: string, role: "classifying" | "reviewing") =>
		queue({ harness: "claude", session, cwd: root, start, pull, branch, role }, env);
	// A round that recorded on no PR, as one whose PR had not opened, pins its branch alone.
	reviewed("rev", null, "quest/m0/a", "reviewing");
	queue({ ...stopped(root), session: "impl" }, env);
	// A fork's PR heads a repository other than the checkout's origin.
	// Resumed after its PR opened, so only its later queue names the PR, whichever pending file is read last.
	reviewed("cls", null, "fix/y", "classifying");
	reviewed("cls", "https://github.com/acme/proj/pull/8", "fix/y", "classifying");
	reviewed("cls", null, "fix/y", "classifying");
	// Reviewed before its PR opens.
	reviewed("early", null, "feature/z", "reviewing");
	// Its round skipped the only PR on its branch, a stranger fork's whose head the checkout lacks.
	reviewed("skipped", null, "patch-1", "reviewing");
	// Its round recorded on another repository's PR of the same number as this one's.
	reviewed("elsewhere", "https://github.com/other/proj/pull/7", "quest/m0/a", "reviewing");
	// The runner's review checkout names its own branch, and a detached one names none. A sub-agent anywhere in the
	// same checkout follows its parent onto the fork's PR.
	const sessions = [
		session("rev", "kix-review/1"),
		session("cls", "x", { branches: [], cwd: root }),
		session("sub", "x", { branches: [], parent: "cls", cwd: root }),
		session("deep", "x", { branches: [], parent: "cls", cwd: `${root}/src` }),
		session("deeper", "x", { branches: [], parent: "sub", cwd: `${root}/src` }),
		// One whose checkout's own branch heads another PR, as under `quest review --branch`, still follows the review.
		session("aside", "quest/m0/a", { parent: "cls", cwd: root }),
		// One in another checkout on a branch no PR heads yet keeps its parent, and the PR its parent recorded on, waiting.
		session("later", "wip/q", { parent: "cls", repositories: ["acme/proj"], cwd: "/other" }),
		session("early", "kix-review/2"),
		session("skipped", "kix-review/3"),
		session("elsewhere", "kix-review/4"),
		// An implementer's sub-agent in another checkout keeps out of the fork's PR.
		session("impl", "fix/y", { repositories: ["ann/proj"], cwd: "/fork" }),
		session("away", "x", { branches: [], parent: "impl", cwd: "/up" }),
	];
	// An editable PR body naming a reviewer as its classifier does not relabel it.
	const fork = {
		...opened(8, "fix/y", "2026-11-06T11:30:00Z"),
		head: { ref: "fix/y", repo: { full_name: "ann/proj" } },
		body: "## Review\n\n- Classified: medium by Claude Code, session `rev`\n",
	};
	const stranger = {
		...opened(9, "patch-1", "2026-11-06T11:30:00Z"),
		head: { ref: "patch-1", repo: { full_name: "eve/proj" } },
	};
	const { deps, uploads } = sender(env, 200, sessions, () => {}, [fork, stranger]);
	await sendPass(deps);
	// No PR body names the classifier, as for one whose reply was unusable.
	expect(parseUpload(uploads[0]!.body).records.map((r) => [r.session, r.pulls, r.role, r.branch])).toEqual([
		["rev", [7], "reviewing", "quest/m0/a"],
		["cls", [8], "classifying", "fix/y"],
		["sub", [8], "classifying", "fix/y"],
		["deep", [8], "classifying", "fix/y"],
		["deeper", [8], "classifying", "fix/y"],
		["aside", [8], "classifying", "fix/y"],
		["later", [], "classifying", "wip/q"],
		["early", [], "reviewing", "feature/z"],
		["skipped", [], "reviewing", "patch-1"],
		["elsewhere", [], "reviewing", "quest/m0/a"],
		["impl", [8], "implementing", "fix/y"],
		["away", [], "implementing", null],
	]);
	// Each waits for a PR on the branch it reviewed, not its checkout's.
	expect(remembered(env)).toEqual(["cls", "early", "skipped"]);
	// The classifier is remembered with the copy naming its PR, so a resend still credits it.
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "remembered");
	const pins = readdirSync(dir).flatMap((group) =>
		readdirSync(join(dir, group)).map(
			(name) => (JSON.parse(readFileSync(join(dir, group, name), "utf8")) as { pending: Pending }).pending,
		),
	);
	expect(pins.find((p) => p.session === "cls")?.reviewed?.pull).toBe("https://github.com/acme/proj/pull/8");
});

test("a session that recorded a transferred repository's former name is sent on the PR its branch heads now", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a", { repositories: ["old/proj"] })]);
	await sendPass(deps);
	const { records } = parseUpload(uploads[0]!.body);
	expect(records.map((r) => [r.session, r.pulls])).toEqual([["s1", [7]]]);
});

test("a repository Kixel Quest does not serve is dropped, unsent and without token-max, and is said once", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const refusing = sender(env, 200, [session("s1", "quest/m0/a")], undefined, [], ["acme/other"]);
	expect(await sendPass(refusing.deps)).toEqual([]);
	expect(refusing.asked).toEqual(["Bearer secret"]);
	expect(refusing.uploads).toEqual([]);
	expect(refusing.windows).toEqual([]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env).notices).toEqual([
		expect.stringContaining(`${URL_} does not serve acme/proj, so its sessions' records are dropped`),
	]);
	// Said once, and a later stop is dropped without a notice.
	queue(stopped(root), env);
	await sendPass(refusing.deps);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env).notices).toEqual([]);
});

test("a repository Kixel Quest serves is matched by the base its PRs open on, not a fork's origin", async () => {
	const env = home();
	const root = checkout();
	execFileSync("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/me/proj.git"]);
	queue(stopped(root), env);
	const pass = sender(env, 200, [session("s1", "quest/m0/a", { repositories: ["me/proj"] })]);
	const github = pass.deps.github;
	pass.deps.github = () => ({
		...github(),
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/repos/me/proj")
				return new Response(
					JSON.stringify({
						owner: { login: "me" },
						name: "proj",
						default_branch: "main",
						clone_url: "https://github.com/me/proj.git",
						ssh_url: "git@github.com:me/proj.git",
						fork: true,
						parent: { owner: { login: "acme" }, name: "proj" },
					}),
				);
			if (url.pathname === "/repos/acme/proj/contents/quest/README.md") return new Response("{}");
			return (github().fetch as typeof fetch)(input, init);
		}) as typeof fetch,
	});
	const [sent] = await sendPass(pass.deps);
	expect(sent).toMatchObject({ repository: "acme/proj", records: 1 });
});

test("a token Kixel Quest refuses at GET /forge drops the queue and stops sending until it changes", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const refusing = sender(env, 200, [session("s1", "quest/m0/a")]);
	const fetch = refusing.deps.fetch;
	refusing.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		String(input) === `${URL_}/forge`
			? new Response("", { status: 401 })
			: fetch(input, init)) as typeof globalThis.fetch;
	expect(await sendPass(refusing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 0, breakages: 0, refused: true },
	]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env)).toEqual({
		notices: [expect.stringContaining("refused this host's token (401)")],
		queued: false,
	});
});

test("a refusal at upload stops the pass's other repositories and drops what is queued", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const other = checkout();
	execFileSync("git", ["-C", other, "remote", "set-url", "origin", "https://github.com/acme/other.git"]);
	queue({ ...stopped(other), session: "s2" }, env);
	const refusing = sender(
		env,
		403,
		[session("s1", "quest/m0/a"), session("s2", "main", { repositories: ["acme/other"] })],
		undefined,
		[],
		["acme/proj", "acme/other"],
	);
	expect(await sendPass(refusing.deps)).toHaveLength(1);
	expect(refusing.uploads).toHaveLength(1);
	expect(pending(env)).toEqual([]);
});

test("a Kixel Quest that cannot say what it serves fails the pass, keeping the queue", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const down = sender(env, 200, [session("s1", "quest/m0/a")]);
	const fetch = down.deps.fetch;
	down.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		String(input) === `${URL_}/forge`
			? new Response("", { status: 503 })
			: fetch(input, init)) as typeof globalThis.fetch;
	await expect(sendPass(down.deps)).rejects.toThrow("failed GET /forge: HTTP 503; its records stay queued");
	expect(pending(env)).toHaveLength(1);
});

test("the sender labels each session's steps and sends its split; one no model could label is sent unsplit", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const file = join(tempDir(), "s1.jsonl");
	writeFileSync(
		file,
		[
			{ type: "user", timestamp: "2026-11-06T10:00:00Z", message: { content: "Go" } },
			{
				type: "assistant",
				timestamp: "2026-11-06T10:05:00Z",
				message: { content: [{ type: "text", text: "Hi" }] },
			},
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	const sessions = [session("s1", "quest/m0/a", { files: [file] })];
	// Labeling never holds the record back: it is sent unsplit, the queue settles, and the next stop says why.
	const failing = sender(env, 200, sessions);
	expect(await sendPass(failing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: false },
	]);
	expect(parseUpload(failing.uploads[0]!.body).records[0]!.split).toBeNull();
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env).notices).toEqual([
		expect.stringContaining("claude session s1 was sent without its time split: no model can label here"),
	]);
	// The next stop labels it.
	const { deps, uploads } = sender(env, 200, sessions);
	deps.ask = async (entries, question) => {
		const usage = { input: 5, cached: 0, output: 1 };
		return {
			entry: entries[0]!,
			session: "x",
			value: question.parse({ ranges: [{ from: 0, to: 0, category: "writing" }], note: "" }),
			usage,
			spent: [{ entry: entries[0]!, usage }],
		};
	};
	await sendPass(deps);
	const [record] = parseUpload(uploads[0]!.body).records;
	expect(record!.split?.categories.writing.ms).toBe(300_000);
	expect(pending(env)).toEqual([]);
});

test("a failed upload stays queued and is said once; a refused token stops sending", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendPass(failing.deps)).rejects.toThrow("answered 500");
	failing.clock.now += 60_000;
	expect(pending(env)).toHaveLength(1);
	const again = queue(stopped(root), env);
	expect(again.notices).toEqual([expect.stringContaining("answered 500")]);
	expect(queue(stopped(root), env).notices).toEqual([]);

	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	expect(await sendPass(refusing.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: true },
	]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env)).toEqual({
		notices: [expect.stringContaining("refused this host's token (403)")],
		queued: false,
	});
	// A new token is tried again.
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "fresh" }));
	expect(queue(stopped(root), env).queued).toBe(true);
});

test("a redirected upload keeps the queue and its cursor, since the endpoint received nothing", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	for (const code of [301, 302, 307]) {
		const moved = sender(env, code, [session("s1", "quest/m0/a")]);
		await expect(sendPass(moved.deps)).rejects.toThrow(
			`answered a redirect (${code} to https://records.example/login), so nothing was sent`,
		);
		moved.clock.now += 24 * 3_600_000;
		expect(pending(env)).toHaveLength(1);
	}
	const ok = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(ok.deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: false },
	]);
	expect(pending(env)).toEqual([]);
});

test("the sender fails loud without token-max, keeping the queue", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	await expect(sendPass(sender(env, 200, null).deps)).rejects.toThrow("token-max is not installed");
	expect(pending(env)).toHaveLength(1);
});

test("a failing group backs off, doubling, without widening the others' window", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 1 minutes");
	// Within its wait, the group sits the pass out: no token-max run, no upload.
	failing.clock.now += 30_000;
	expect(await sendPass(failing.deps)).toEqual([]);
	expect(failing.windows).toHaveLength(1);
	failing.clock.now += 30_000;
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 2 minutes");
	failing.clock.now += 60_000;
	expect(await sendPass(failing.deps)).toEqual([]);
	// Another repository's stop, queued later, is sent from its own start meanwhile.
	const other = checkout();
	execFileSync("git", ["-C", other, "remote", "set-url", "origin", "https://github.com/acme/other.git"]);
	writeFileSync(join(other, "later.jsonl"), `{"type":"user","timestamp":"2026-11-06T11:00:00Z"}\n`);
	queue({ ...stopped(other), session: "s2", transcript: join(other, "later.jsonl") }, env);
	const others = sender(
		env,
		200,
		[session("s2", "main", { repositories: ["acme/other"] })],
		undefined,
		[],
		["acme/proj", "acme/other"],
	);
	expect(await sendPass(others.deps)).toHaveLength(1);
	expect(others.windows).toEqual([new Date("2026-11-06T11:00:00Z")]);
	// Once its wait ends, the first group is tried again and sent.
	failing.clock.now += 60_000;
	const fixed = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(fixed.deps)).toHaveLength(1);
	expect(fixed.uploads).toHaveLength(1);
	expect(pending(env)).toEqual([]);
});

test("an unreadable backoff file reads as none, so it blocks no group", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const failing = sender(env, 500, [session("s1", "quest/m0/a")]);
	await expect(sendPass(failing.deps)).rejects.toThrow("tried again in 1 minutes");
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "backoff");
	const [name] = readdirSync(dir);
	expect(readdirSync(dir)).toEqual([name]);
	// As a crash mid-write would leave it, were it written in place.
	writeFileSync(join(dir, name!), '{"failures":');
	const sent = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(sent.deps)).toHaveLength(1);
	expect(readdirSync(dir)).toEqual([]);
});

test("an upload this version's own parseUpload refuses fails on the host, never posted", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a", { cost: -1 })]);
	await expect(sendPass(deps)).rejects.toThrow("its own parseUpload refuses");
	expect(uploads).toEqual([]);
	expect(pending(env)).toHaveLength(1);
});

test("a session token-max no longer lists is dropped and said, without holding back the rest", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	queue({ ...stopped(root), session: "gone" }, env);
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a")]);
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 0, refused: false },
	]);
	expect(parseUpload(uploads[0]!.body).records.map((r) => r.session)).toEqual(["s1"]);
	expect(pending(env)).toEqual([]);
	expect(queue(stopped(root), env).notices).toEqual([
		expect.stringContaining("lists no claude session gone on this host, so its record was dropped"),
	]);
});

test("a sub-agent is sent only where its own checkout routes it", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const other = checkout();
	execFileSync("git", ["-C", other, "remote", "set-url", "origin", "https://github.com/acme/fork.git"]);
	const sessions = [
		session("s1", "quest/m0/a"),
		// Live checkouts: this one, another of the same origin, and another origin's.
		session("here", "quest/m0/a", { parent: "s1", cwd: root }),
		session("twin", "quest/m0/a", { parent: "s1", cwd: checkout() }),
		// A deleted folder routes by the checkout still holding its nearest existing parent.
		session("hereGone", "quest/m0/a", { parent: "s1", cwd: join(root, "deleted", "sub") }),
		// A deleted nested clone of another repository, inside this checkout.
		session("nestedGone", "main", {
			parent: "s1",
			cwd: join(root, "vendor", "other"),
			repositories: ["acme/other"],
		}),
		session("fork", "quest/m0/a", { parent: "s1", cwd: other, repositories: ["acme/fork", "acme/proj"] }),
		// Deleted checkouts: every repository resolved must be this one's.
		session("gone", "quest/m0/a", { parent: "s1" }),
		session("goneFork", "quest/m0/a", { parent: "s1", repositories: ["acme/fork", "acme/proj"] }),
		session("unknown", "quest/m0/a", { parent: "s1", repositories: null }),
	];
	const { deps, uploads } = sender(env, 200, sessions);
	await sendPass(deps);
	expect(parseUpload(uploads[0]!.body).records.map((r) => r.session)).toEqual([
		"s1",
		"here",
		"twin",
		"hereGone",
		"gone",
	]);
});

test("an origin that a URL rewrite points at GitHub is read as configured", () => {
	const env = home();
	const root = checkout();
	execFileSync("git", ["-C", root, "remote", "set-url", "origin", "gh:acme/proj"]);
	execFileSync("git", ["-C", root, "config", "url.https://github.com/.insteadOf", "gh:"]);
	expect(queue(stopped(root), env).queued).toBe(true);
	execFileSync("git", ["-C", root, "config", "--unset", "url.https://github.com/.insteadOf"]);
	execFileSync("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/acme/proj.git"]);
	execFileSync("git", ["-C", root, "config", "url.git@github-work:.insteadOf", "https://github.com/"]);
	expect(queue(stopped(root), env).queued).toBe(true);
});

test("Claude Code's and Codex's Stop queue the session", () => {
	const env = home();
	const cwd = checkout();
	const deps = { env };
	const base = { hook_event_name: "Stop", cwd, session_id: "c1", transcript_path: transcript() };
	expect(hook({ ...base, background_tasks: [] }, deps)).toBe("");
	expect(hook({ ...base, session_id: "x1", turn_id: "t1" }, deps)).toBe("");
	expect(pending(env)).toHaveLength(2);
	// A sub-agent goes with its parent, so its stop queues nothing.
	expect(hook({ ...base, hook_event_name: "SubagentStop", background_tasks: [] }, deps)).toBe("");
	expect(pending(env)).toHaveLength(2);
	// What it cannot queue, it says instead of failing the hook.
	writeFileSync(tokensPath(env), "{");
	expect(JSON.parse(hook({ ...base, background_tasks: [] }, deps)).systemMessage).toContain(
		"cannot queue this session's record",
	);
	expect(() => hook({ hook_event_name: "Stop", cwd, turn_id: "t1" }, deps)).toThrow("session_id");
	// An ephemeral Codex session keeps no transcript, so its stop queues nothing.
	expect(hook({ ...base, session_id: "e1", transcript_path: null, turn_id: "t1" }, deps)).toBe("");
});

test("the sender passes every interval, records its PID, and outlives a failed pass", async () => {
	const env = home();
	writeFileSync(senderPid(env), "");
	const root = checkout();
	queue(stopped(root), env);
	let status = 500;
	const { deps, uploads, slept, clock } = sender(env, () => status, [session("s1", "quest/m0/a")]);
	const log: string[] = [];
	deps.sleep = async (ms) => {
		slept.push(ms);
		clock.now += ms;
		status = 200;
		if (slept.length === 3) throw new Error("stopped");
	};
	await expect(runSender(deps, (line) => log.push(line))).rejects.toThrow("stopped");
	expect(readFileSync(senderPid(env), "utf8")).toBe(String(process.pid));
	expect(slept).toEqual([60_000, 60_000, 60_000]);
	// The failed pass keeps the session; the next sends it, and the last finds the queue empty.
	expect(uploads).toHaveLength(2);
	expect(log).toEqual([
		expect.stringContaining("answered 500"),
		`sent 1 records and 0 breakages of acme/proj to ${ENDPOINT}`,
	]);
	expect(pending(env)).toEqual([]);
});

test("a stop with no sender running queues the session and says so once per outage", () => {
	const env = home();
	const root = checkout();
	writeFileSync(senderPid(env), "999999999");
	const down = queue(stopped(root), env);
	expect(down).toEqual({
		notices: [expect.stringContaining("no session record sender runs on this host")],
		queued: true,
	});
	expect(down.notices[0]).toContain("quest records install");
	expect(queue(stopped(root), env)).toEqual({ notices: [], queued: true });
	expect(pending(env)).toHaveLength(2);
	// A sender that ran again and stopped is a new outage.
	writeFileSync(senderPid(env), "999999998");
	expect(queue(stopped(root), env).notices).toHaveLength(1);
	writeFileSync(senderPid(env), String(process.pid));
	expect(queue(stopped(root), env).notices).toEqual([]);
});

test("a stop queued while its earlier record uploads stays queued", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const first = sender(env, 200, [session("s1", "quest/m0/a")], () => {
		if (first.uploads.length === 1) queue(stopped(root), env);
	});
	await sendPass(first.deps);
	expect(pending(env)).toHaveLength(1);
	const next = sender(env, 200, [session("s1", "quest/m0/a")]);
	await sendPass(next.deps);
	expect(next.uploads).toHaveLength(1);
	expect(pending(env)).toEqual([]);
});

test("a queued session for an endpoint that refused its token is dropped unsent", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const refusing = sender(env, 403, [session("s1", "quest/m0/a")]);
	// Queued before the refusal, so queue() could not drop it.
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "pending");
	const [name] = readdirSync(dir);
	const copy = readFileSync(join(dir, name!), "utf8");
	await sendPass(refusing.deps);
	writeFileSync(join(dir, name!), copy);
	const later = sender(env, 200, [session("s1", "quest/m0/a")]);
	await sendPass(later.deps);
	expect(later.uploads).toEqual([]);
	expect(pending(env)).toEqual([]);
});

test("the sender sends the breakages a merged fix in its window names, reading an older culprit", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const fix = {
		...CULPRIT,
		number: 8,
		head: { ref: "fix/c", repo: { full_name: "acme/proj" } },
		merged_at: "2026-11-06T10:50:00Z",
		created_at: "2026-11-06T10:20:00Z",
		updated_at: "2026-11-06T10:50:00Z",
		closed_at: "2026-11-06T10:50:00Z",
		body: "## Caused by\n\n- [acme/proj#3](https://github.com/acme/proj/pull/3) - lost a frame (found by the queue)\n",
	};
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a")], () => {}, [fix]);
	expect(await sendPass(deps)).toEqual([
		{ endpoint: ENDPOINT, repository: "acme/proj", records: 1, breakages: 1, refused: false },
	]);
	expect(parseUpload(uploads[0]!.body).breakages).toEqual([
		{
			repository: "acme/proj",
			culprit: {
				number: 3,
				merged: "2026-10-01T00:00:00.000Z",
				tier: null,
				size: "M",
				writers: [{ harness: "Claude Code", model: "claude-opus-5-5", effort: "medium" }],
				reviewers: [],
			},
			fix: 8,
			incident: null,
			found: "queue",
			at: "2026-11-06T10:20:00.000Z",
		},
	]);
});

test("an incident is posted at once, open until reported again with its culprit, and fails loud", async () => {
	const env = home();
	const root = checkout();
	const { deps, uploads } = sender(env, 200, []);
	const report = (pull: number | null) =>
		reportIncident(
			{
				cwd: root,
				id: "https://alerts.example/1",
				found: "canary",
				pull,
				at: Date.parse("2026-11-06T12:00:00Z"),
			},
			deps,
		);
	expect((await report(null)).culprit).toBeNull();
	expect((await report(3)).culprit).toMatchObject({ number: 3, size: "M" });
	expect(uploads.map((u) => parseUpload(u.body))).toEqual([
		{
			records: [],
			breakages: [
				expect.objectContaining({
					incident: "https://alerts.example/1",
					culprit: null,
					fix: null,
					found: "canary",
					at: "2026-11-06T12:00:00.000Z",
				}),
			],
		},
		{ records: [], breakages: [expect.objectContaining({ culprit: expect.objectContaining({ number: 3 }) })] },
	]);
	await expect(report(4)).rejects.toThrow("acme/proj has no PR #4");
	await expect(
		reportIncident({ cwd: root, id: "x", found: "person", pull: null, at: 0 }, sender(env, 403, []).deps),
	).rejects.toThrow("answered 403");
	await expect(
		reportIncident({ cwd: root, id: "x", found: "person", pull: null, at: 0 }, sender(home(null), 200, []).deps),
	).rejects.toThrow("holds no token");
});

test("a fix that merges after its sessions were sent reaches the store with the next session", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const fix = (merged: boolean) => ({
		...CULPRIT,
		number: 8,
		head: { ref: "fix/c", repo: { full_name: "acme/proj" } },
		state: merged ? "closed" : "open",
		merged_at: merged ? "2026-11-06T12:30:00Z" : null,
		closed_at: merged ? "2026-11-06T12:30:00Z" : null,
		created_at: "2026-11-06T10:20:00Z",
		updated_at: merged ? "2026-11-06T12:30:00Z" : "2026-11-06T10:20:00Z",
		body: "## Caused by\n\n- [acme/proj#3](https://github.com/acme/proj/pull/3) - lost a frame\n",
	});
	const open = sender(env, 200, [session("s1", "quest/m0/a")], () => {}, [fix(false)]);
	expect((await sendPass(open.deps))[0]).toMatchObject({ records: 1, breakages: 0 });
	// The next session starts after the fix merged, so its own window alone would miss the fix.
	writeFileSync(join(root, "later.jsonl"), `{"type":"user","timestamp":"2026-11-06T13:00:00Z"}\n`);
	queue({ ...stopped(root), session: "s2", transcript: join(root, "later.jsonl") }, env);
	const later = session("s2", "main", {
		start: Date.parse("2026-11-06T13:00:00Z"),
		end: Date.parse("2026-11-06T13:30:00Z"),
		branches: [
			{ name: "main", first: Date.parse("2026-11-06T13:00:00Z"), last: Date.parse("2026-11-06T13:30:00Z") },
		],
	});
	const merged = sender(env, 200, [later], () => {}, [fix(true)]);
	merged.clock.now = Date.parse("2026-11-06T14:00:00Z");
	await sendPass(merged.deps);
	expect(parseUpload(merged.uploads[0]!.body).breakages.map((b) => [b.culprit?.number, b.fix])).toEqual([[3, 8]]);
});

test("an incident reported from a subdirectory as `.`, as with no --root, finds its checkout", async () => {
	const env = home();
	const root = checkout();
	mkdirSync(join(root, "sub"));
	const { deps } = sender(env, 200, []);
	const before = process.cwd();
	process.chdir(join(root, "sub"));
	try {
		const reported = await reportIncident({ cwd: ".", id: "x", found: "person", pull: null, at: 0 }, deps);
		expect(reported.repository).toBe("acme/proj");
	} finally {
		process.chdir(before);
	}
});

test("a merged fix naming an open incident sends one record under the incident, once however many name it", async () => {
	const env = home();
	queue(stopped(checkout()), env);
	const fix = (number: number, updated: string) => ({
		...CULPRIT,
		number,
		head: { ref: `fix/${number}`, repo: { full_name: "acme/proj" } },
		merged_at: updated,
		created_at: "2026-11-06T10:20:00Z",
		updated_at: updated,
		closed_at: updated,
		body: "## Caused by\n\n- [acme/proj#3](https://github.com/acme/proj/pull/3) - lost a frame (found by canary; incident deploy 42)\n",
	});
	const pulls = [fix(9, "2026-11-06T10:55:00Z"), fix(8, "2026-11-06T10:50:00Z")];
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a")], () => {}, pulls);
	await sendPass(deps);
	expect(parseUpload(uploads[0]!.body).breakages.map((b) => [b.culprit?.number, b.fix, b.incident, b.found])).toEqual(
		[[3, 9, "deploy 42", "canary"]],
	);
});

test("an incident's --at must be a date and time with a Z or offset, on a real calendar day", () => {
	expect(parseInstant("2026-11-06T10:00:00Z")).toBe(Date.parse("2026-11-06T10:00:00Z"));
	expect(parseInstant("2026-11-06T10:00+02:00")).toBe(Date.parse("2026-11-06T08:00:00Z"));
	expect(parseInstant("2024-02-29T10:00:00.5Z")).toBe(Date.parse("2024-02-29T10:00:00.500Z"));
	for (const text of [
		"2026-11-06",
		"2026-11-06T10:00:00",
		"2026-02-30T10:00:00Z",
		"2026-11-06T24:00:00Z",
		"2026-11-06T10:00:00+25:00",
		"Nov 6 2026 10:00 UTC",
	])
		expect(parseInstant(text), text).toBeNull();
});

/** A PR of acme/proj from `branch`, opened and last updated at `at`. */
const opened = (number: number, branch: string, at: string) => ({
	number,
	html_url: `https://github.com/acme/proj/pull/${number}`,
	title: "B",
	head: { ref: branch, repo: { full_name: "acme/proj" } },
	state: "open",
	draft: true,
	merged_at: null,
	created_at: at,
	updated_at: at,
	closed_at: null,
	body: "",
});

const remembered = (env: NodeJS.ProcessEnv) => {
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "remembered");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.flatMap((group) => readdirSync(join(dir, group)).map((name) => join(dir, group, name)))
		.map((path) => (JSON.parse(readFileSync(path, "utf8")) as { pending: { session: string } }).pending.session)
		.sort();
};

/** A later session on main in `root`, queued, which only brings its group's next pass. */
function later(env: NodeJS.ProcessEnv, root: string, id: string): Session {
	writeFileSync(join(root, `${id}.jsonl`), `{"type":"user","timestamp":"2026-11-06T13:00:00Z"}\n`);
	queue({ ...stopped(root), session: id, transcript: join(root, `${id}.jsonl`) }, env);
	const at = Date.parse("2026-11-06T13:00:00Z");
	return session(id, "main", {
		start: at,
		end: at + 60_000,
		branches: [{ name: "main", first: at, last: at + 60_000 }],
		files: [join(root, `${id}.jsonl`)],
	});
}

test("a session sent before its branch's PR opened is resent with the PR on its group's next pass", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const first = session("s1", "fix/x", { files: [transcript()] });
	const before = sender(env, 200, [first]);
	await sendPass(before.deps);
	expect(parseUpload(before.uploads[0]!.body).records.map((r) => [r.session, r.pulls])).toEqual([["s1", []]]);
	expect(remembered(env)).toEqual(["s1"]);
	// The PR opens; nothing reads it until the repository's next session is sent, which queues s1 again.
	const s2 = later(env, root, "s2");
	const pr = opened(9, "fix/x", "2026-11-06T13:30:00Z");
	const next = sender(env, 200, [first, s2], () => {}, [pr]);
	next.clock.now = Date.parse("2026-11-06T14:00:00Z");
	await sendPass(next.deps);
	expect(parseUpload(next.uploads[0]!.body).records.map((r) => r.session)).toEqual(["s2"]);
	expect(pending(env)).toHaveLength(1);
	// Its resend widens token-max's window back to its start, once, and names the PR; nothing waits after it.
	const resend = sender(env, 200, [first, s2], () => {}, [pr]);
	await sendPass(resend.deps);
	expect(resend.windows).toEqual([new Date("2026-11-06T10:00:00Z")]);
	expect(parseUpload(resend.uploads[0]!.body).records.map((r) => [r.session, r.pulls, r.role])).toEqual([
		["s1", [9], "implementing"],
	]);
	expect(pending(env)).toEqual([]);
	// s2 stays remembered, as main heads no PR either.
	expect(remembered(env)).toEqual(["s2"]);
});

test("a session remembered under a repository's former name is resent once a PR opens on its branch there", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const first = session("s1", "fix/x", { files: [transcript()] });
	await sendPass(sender(env, 200, [first]).deps);
	// The record was remembered before the repository moved, so it names the repository's former name.
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "remembered");
	for (const group of readdirSync(dir))
		for (const name of readdirSync(join(dir, group))) {
			const path = join(dir, group, name);
			writeFileSync(path, readFileSync(path, "utf8").replaceAll("acme/proj", "old/proj"));
		}
	const s2 = later(env, root, "s2");
	const next = sender(env, 200, [first, s2], () => {}, [opened(9, "fix/x", "2026-11-06T13:30:00Z")]);
	next.clock.now = Date.parse("2026-11-06T14:00:00Z");
	await sendPass(next.deps);
	expect(pending(env)).toHaveLength(1);
});

test("a remembered repository GitHub fails to answer for holds the group's upload back, not repeats it", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const first = session("s1", "fix/x", { files: [transcript()] });
	await sendPass(sender(env, 200, [first]).deps);
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "remembered");
	for (const group of readdirSync(dir))
		for (const name of readdirSync(join(dir, group))) {
			const path = join(dir, group, name);
			writeFileSync(path, readFileSync(path, "utf8").replaceAll("acme/proj", "broken/proj"));
		}
	const s2 = later(env, root, "s2");
	const next = sender(env, 200, [first, s2]);
	const github = next.deps.github;
	next.deps.github = () => ({
		...github(),
		fetch: (async (input: string | URL | Request, init?: RequestInit) =>
			new URL(String(input)).pathname === "/repos/broken/proj"
				? new Response("down", { status: 500 })
				: (github().fetch as typeof fetch)(input, init)) as typeof fetch,
	});
	await expect(sendPass(next.deps)).rejects.toThrow("broken/proj");
	expect(next.uploads).toEqual([]);
});

test("a pass that fails before its resends are queued reads their PRs again, even ones older than its sessions", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const first = session("s1", "fix/x", { files: [transcript()] });
	await sendPass(sender(env, 200, [first]).deps);
	expect(remembered(env)).toEqual(["s1"]);
	// The PR opens at 12:30, before s2 starts, so only the cursor's read still reaches it.
	const s2 = later(env, root, "s2");
	const pr = opened(9, "fix/x", "2026-11-06T12:30:00Z");
	const queueDir = join(env.XDG_STATE_HOME!, "quest", "records", "pending");
	// The upload succeeds, then queueing s1's resend fails: the queue's directory is a file for the rest of the pass.
	const failing = sender(
		env,
		200,
		[first, s2],
		() => {
			renameSync(queueDir, `${queueDir}.away`);
			writeFileSync(queueDir, "");
		},
		[pr],
	);
	failing.clock.now = Date.parse("2026-11-06T14:00:00Z");
	await expect(sendPass(failing.deps)).rejects.toThrow("EEXIST");
	rmSync(queueDir);
	renameSync(`${queueDir}.away`, queueDir);
	expect(pending(env)).toHaveLength(1);
	const retry = sender(env, 200, [first, s2], () => {}, [pr]);
	retry.clock.now += 120_000;
	await sendPass(retry.deps);
	expect(pending(env)).toHaveLength(1);
	const resend = sender(env, 200, [first, s2], () => {}, [pr]);
	await sendPass(resend.deps);
	expect(parseUpload(resend.uploads[0]!.body).records.map((r) => [r.session, r.pulls])).toEqual([["s1", [9]]]);
});

test("a resend names every PR its earlier upload did, even one its own window misses", async () => {
	const env = home();
	const root = checkout();
	const at = (time: string) => Date.parse(`2026-11-06T${time}:00Z`);
	// s0 starts at 10:00, so the first upload reads PR 7, last updated at 11:00; s1 starts after that update.
	queue({ ...stopped(root), session: "s0" }, env);
	writeFileSync(join(root, "s1.jsonl"), `{"type":"user","timestamp":"2026-11-06T11:30:00Z"}\n`);
	queue({ ...stopped(root), transcript: join(root, "s1.jsonl") }, env);
	const s0 = session("s0", "main", { files: [transcript()] });
	const late = { start: at("11:30"), end: at("11:50") };
	const s1 = session("s1", "quest/m0/a", {
		...late,
		files: [join(root, "s1.jsonl")],
		branches: [{ name: "quest/m0/a", first: at("11:30"), last: at("11:40") }],
	});
	const sub = session("sub", "fix/sub", {
		...late,
		parent: "s1",
		branches: [{ name: "fix/sub", first: at("11:30"), last: at("11:40") }],
	});
	const first = sender(env, 200, [s0, s1, sub]);
	await sendPass(first.deps);
	expect(parseUpload(first.uploads[0]!.body).records.map((r) => [r.session, r.pulls])).toEqual([
		["s0", []],
		["s1", [7]],
		["sub", [7]],
	]);
	// The sub-agent's PR opens, so the tree is resent, alone in its group's pass.
	const s2 = later(env, root, "s2");
	const pr = opened(11, "fix/sub", "2026-11-06T13:30:00Z");
	const next = sender(env, 200, [s0, s1, sub, s2], () => {}, [pr]);
	next.clock.now = at("14:00");
	await sendPass(next.deps);
	const resend = sender(env, 200, [s0, s1, sub, s2], () => {}, [pr]);
	await sendPass(resend.deps);
	expect(resend.windows).toEqual([new Date(late.start)]);
	expect(parseUpload(resend.uploads[0]!.body).records.map((r) => [r.session, r.pulls])).toEqual([
		["s1", [7]],
		["sub", [11]],
	]);
});

test("a moved session and a sub-agent's fresh branch wait for their own PRs; a PR on an older branch triggers nothing", async () => {
	const env = home();
	const root = checkout();
	queue(stopped(root), env);
	const at = (time: string) => Date.parse(`2026-11-06T${time}:00Z`);
	// s1 moved from quest/m0/a, whose PR 7 is open, to fix/y; its sub-agent works on fix/sub.
	const s1 = session("s1", "quest/m0/a", {
		files: [transcript()],
		branches: [
			{ name: "quest/m0/a", first: at("10:00"), last: at("10:10") },
			{ name: "fix/y", first: at("10:20"), last: at("10:30") },
		],
	});
	const sub = session("sub", "fix/sub", { parent: "s1" });
	const first = sender(env, 200, [s1, sub]);
	await sendPass(first.deps);
	expect(parseUpload(first.uploads[0]!.body).records.map((r) => [r.session, r.pulls])).toEqual([
		["s1", [7]],
		["sub", [7]],
	]);
	const pass = async (id: string, now: string, pulls: object[]) => {
		const s = later(env, root, id);
		const each = sender(env, 200, [s1, sub, s], () => {}, pulls);
		each.clock.now = Date.parse(`2026-11-06T${now}:00Z`);
		await sendPass(each.deps);
		const resend = sender(env, 200, [s1, sub, s], () => {}, pulls);
		await sendPass(resend.deps);
		return resend.uploads.map((u) => parseUpload(u.body).records.map((r) => [r.session, r.pulls]));
	};
	// Newest update first, as GitHub lists them.
	const pulls = [
		opened(12, "fix/y", "2026-11-06T15:30:00Z"),
		opened(11, "fix/sub", "2026-11-06T14:30:00Z"),
		opened(10, "quest/m0/a", "2026-11-06T13:30:00Z"),
	];
	// Another PR on quest/m0/a changes nothing attribution would send.
	expect(await pass("s2", "14:00", pulls.slice(2))).toEqual([]);
	// A PR on the sub-agent's branch resends the tree; s1 still waits for fix/y.
	expect(await pass("s3", "15:00", pulls.slice(1))).toEqual([
		[
			["s1", [7]],
			["sub", [11]],
		],
	]);
	expect(remembered(env)).toEqual(["s1", "s2", "s3"]);
	expect(await pass("s4", "16:00", pulls)).toEqual([
		[
			["s1", [12]],
			["sub", [11]],
		],
	]);
	expect(remembered(env)).toEqual(["s2", "s3", "s4"]);
});

test("a remembered session is forgotten once its transcript is gone, unreadable, or unlisted, without a notice", async () => {
	const env = home();
	const root = checkout();
	const files = [transcript(), transcript(), transcript()];
	for (const id of ["gone", "garbled", "unlisted"]) queue({ ...stopped(root), session: id }, env);
	const sessions = ["gone", "garbled", "unlisted"].map((id, i) => session(id, `fix/${id}`, { files: [files[i]!] }));
	await sendPass(sender(env, 200, sessions).deps);
	expect(remembered(env)).toEqual(["garbled", "gone", "unlisted"]);
	rmSync(files[0]!);
	const dir = join(env.XDG_STATE_HOME!, "quest", "records", "remembered");
	const [group] = readdirSync(dir);
	for (const name of readdirSync(join(dir, group!))) {
		const path = join(dir, group!, name);
		// Its JSON parses, but a waiting entry is null, which would throw on every pass if read as a branch.
		const kept = readFileSync(path, "utf8");
		if (kept.includes('"garbled"')) writeFileSync(path, JSON.stringify({ ...JSON.parse(kept), waiting: [null] }));
	}
	// Every branch's PR opens; only the session whose transcript is still there is queued again.
	const pulls = ["gone", "garbled", "unlisted"].map((id, i) => opened(20 + i, `fix/${id}`, "2026-11-06T13:30:00Z"));
	const s2 = later(env, root, "s2");
	const next = sender(env, 200, [...sessions, s2], () => {}, pulls);
	next.clock.now = Date.parse("2026-11-06T14:00:00Z");
	await sendPass(next.deps);
	expect(pending(env)).toHaveLength(1);
	expect(remembered(env)).toEqual(["s2", "unlisted"]);
	// token-max no longer lists it, as once its transcript is pruned: it is dropped without a notice.
	const resend = sender(env, 200, [s2], () => {}, pulls);
	await sendPass(resend.deps);
	expect(resend.uploads).toEqual([]);
	expect(pending(env)).toEqual([]);
	expect(remembered(env)).toEqual(["s2"]);
	expect(queue(stopped(root), env).notices).toEqual([]);
});

/** Two more Kixel Quests, which a user's tokens file pairs with tokens of their own. */
const OTHER = "https://other.example";
const GONE = "https://gone.example";

/** Route a sender's requests for `OTHER` and `GONE` to the one fake store, recording each request's host and token. */
function viaHosts(deps: SendDependencies, refuse: string[] = []) {
	const hosts: { host: string; path: string; token: string }[] = [];
	const fetch = deps.fetch;
	deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = init?.headers as Record<string, string>;
		hosts.push({ host: url.origin, path: url.pathname, token: headers.authorization ?? headers.Authorization! });
		if (refuse.includes(url.origin) && url.pathname === "/forge") return new Response("", { status: 401 });
		return fetch(`${URL_}${url.pathname}`, init);
	}) as typeof globalThis.fetch;
	return hosts;
}

test.each([
	["names a third Kixel Quest", "https://elsewhere.example"],
	["names none", undefined],
])("a record is sent to the Kixel Quest its hook queued it for when the sender's environment %s", async (_, named) => {
	const env = home();
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "one", [OTHER]: "two", [GONE]: "three" }));
	const root = checkout();
	queue({ ...stopped(root), session: "s1" }, env);
	queue({ ...stopped(root), session: "s2" }, { ...env, QUEST_KIXEL_URL: OTHER });
	queue({ ...stopped(root), session: "s3" }, { ...env, QUEST_KIXEL_URL: GONE });
	// The person removed one token after its record was queued.
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "one", [OTHER]: "two" }));
	const sessions = [session("s1", "quest/m0/a"), session("s2", "quest/m0/a"), session("s3", "quest/m0/a")];
	const { deps, uploads } = sender({ ...env, QUEST_KIXEL_URL: named }, 200, sessions);
	const hosts = viaHosts(deps);
	expect(await sendPass(deps)).toHaveLength(2);
	// Queue files are named by random IDs, so the Kixel Quests are reached in no fixed order.
	const reached = hosts.filter((h) => h.path === "/records").map((h) => [h.host, h.token]);
	expect(reached.sort()).toEqual([
		[URL_, "Bearer one"],
		[OTHER, "Bearer two"],
	]);
	expect(uploads.map((u) => parseUpload(u.body).records.map((r) => r.session)).sort()).toEqual([["s1"], ["s2"]]);
	expect(pending(env)).toEqual([]);
});

test("a Kixel Quest that refuses its token drops only its own records", async () => {
	const env = home();
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "one", [OTHER]: "two" }));
	const root = checkout();
	queue({ ...stopped(root), session: "s1" }, env);
	queue({ ...stopped(root), session: "s2" }, { ...env, QUEST_KIXEL_URL: OTHER });
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a"), session("s2", "quest/m0/a")]);
	viaHosts(deps, [OTHER]);
	const sent = await sendPass(deps);
	expect(sent.map((s) => [s.endpoint, s.refused]).sort()).toEqual([
		[ENDPOINT, false],
		[`${OTHER}/records`, true],
	]);
	expect(uploads.map((u) => parseUpload(u.body).records.map((r) => r.session))).toEqual([["s1"]]);
	expect(pending(env)).toEqual([]);
});

test("a failing Kixel Quest keeps its records without holding back another's", async () => {
	const env = home();
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "one", [OTHER]: "two" }));
	const root = checkout();
	queue({ ...stopped(root), session: "s1" }, env);
	queue({ ...stopped(root), session: "s2" }, { ...env, QUEST_KIXEL_URL: OTHER });
	const { deps, uploads } = sender(env, 200, [session("s1", "quest/m0/a"), session("s2", "quest/m0/a")]);
	const fetch = deps.fetch;
	deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		String(input).startsWith(OTHER)
			? new Response("down", { status: 503 })
			: fetch(input, init)) as typeof globalThis.fetch;
	await expect(sendPass(deps)).rejects.toThrow(OTHER);
	expect(uploads).toHaveLength(1);
	expect(pending(env)).toHaveLength(1);
});

test("each Kixel Quest that does not serve a repository says so once, whichever said it first", async () => {
	const env = home();
	writeFileSync(tokensPath(env), JSON.stringify({ [URL_]: "one", [OTHER]: "two" }));
	const root = checkout();
	queue({ ...stopped(root), session: "s1" }, env);
	queue({ ...stopped(root), session: "s2" }, { ...env, QUEST_KIXEL_URL: OTHER });
	const { deps } = sender(env, 200, [session("s1", "quest/m0/a"), session("s2", "quest/m0/a")], undefined, [], []);
	viaHosts(deps);
	expect(await sendPass(deps)).toEqual([]);
	expect(pending(env)).toEqual([]);
	const [notice] = queue({ ...stopped(root), session: "s3" }, env).notices;
	expect(notice).toContain(`${URL_} does not serve acme/proj`);
	expect(notice).toContain(`${OTHER} does not serve acme/proj`);
});
