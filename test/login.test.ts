import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { hostedForge } from "../src/cli/forge";
import { type LoginDependencies, TRANSCRIPTS_QUESTION, login, logout } from "../src/cli/login";
import { tokenFor, tokensPath } from "../src/cli/tokens";
import { tempDir } from "./fixture";
import { FakeLogin, KIXEL, REPOSITORY, writeTokens } from "./kixel-fakes";

/** A host about to sign in to the fake, answering `answer` to the transcripts question, approved after `pending` polls. */
function host(server: FakeLogin, answer: string | null = "n", env: NodeJS.ProcessEnv = user(), pending = 2) {
	let now = 0;
	const said: string[] = [];
	const asked: string[] = [];
	const deps: LoginDependencies = {
		env,
		fetch: server.fetch,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			if (server.polls === pending) server.approve();
		},
		hostname: "workstation",
		ask: async (question) => {
			asked.push(question);
			return answer;
		},
		say: (line) => said.push(line),
	};
	return { deps, env, said, asked, clock: () => now };
}

const user = (): NodeJS.ProcessEnv => ({ XDG_CONFIG_HOME: tempDir(), QUEST_KIXEL_URL: KIXEL });

test("an approved code stores a token named after the host, readable only by the user", async () => {
	const server = new FakeLogin();
	const { deps, env, said, asked, clock } = host(server);
	expect(await login(deps)).toEqual({ url: KIXEL, label: "workstation", transcripts: false });
	expect(asked).toEqual([TRANSCRIPTS_QUESTION]);
	expect(server.labels).toEqual(["workstation"]);
	expect(said).toEqual([
		`Open ${KIXEL}/login, sign in with GitHub, and enter the code BCDF-GHJK.`,
		"Waiting for its approval; the code expires in 10 minutes.",
	]);
	// Asked at the interval the code names: twice pending, then approved.
	expect(server.polls).toBe(3);
	expect(clock()).toBe(15_000);
	expect(tokenFor(KIXEL, env)).toBe("issued-1");
	expect(statSync(tokensPath(env)).mode & 0o777).toBe(0o600);
});

test("only a yes uploads transcripts, and no answer signs nothing in", async () => {
	for (const [answer, transcripts] of [
		["y", true],
		[" YES ", true],
		["", false],
		["sure", false],
	] as const) {
		const { deps, env } = host(new FakeLogin(), answer);
		expect((await login(deps)).transcripts).toBe(transcripts);
		expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))[KIXEL].transcripts).toBe(transcripts);
	}
	const server = new FakeLogin();
	const { deps, env } = host(server, null);
	await expect(login(deps)).rejects.toThrow("no answer to whether to upload transcripts");
	expect(server.labels).toEqual([]);
	expect(existsSync(tokensPath(env))).toBe(false);
});

test("a code nobody approves expires, storing nothing", async () => {
	const server = new FakeLogin();
	const { deps, env, clock } = host(server, "n", user(), Infinity);
	await expect(login(deps)).rejects.toThrow("the code expired before anyone approved it; run `quest login` again");
	expect(server.polls).toBe(119);
	expect(clock()).toBe(600_000);
	expect(existsSync(tokensPath(env))).toBe(false);
});

test("an answer quest cannot trust or read fails the login", async () => {
	for (const [code, error] of [
		[{ verification_uri: "" }, "verification_uri is not a string"],
		[{ interval: 0 }, "interval is not a positive whole number"],
		[{ expires_in: "600" }, "expires_in is not a positive whole number"],
	] as const) {
		const { deps } = host(new FakeLogin(KIXEL, code));
		await expect(login(deps)).rejects.toThrow(error);
	}
	const { deps } = host(new FakeLogin());
	deps.hostname = "";
	await expect(login(deps)).rejects.toThrow(`${KIXEL}/login/device answered HTTP 400: invalid_request`);
	const expired = host(new FakeLogin());
	expired.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		String(input).endsWith("/login/token")
			? new Response(JSON.stringify({ error: "expired_token" }), { status: 400 })
			: new FakeLogin().fetch(input, init)) as typeof fetch;
	await expect(login(expired.deps)).rejects.toThrow("the code expired");
});

test("signing in again replaces this Kixel Quest's token and keeps another's", async () => {
	const env = user();
	writeTokens(env, { [KIXEL]: "old", "https://kixel.quest": "theirs" });
	await login(host(new FakeLogin(), "y", env).deps);
	expect(tokenFor(KIXEL, env)).toBe("issued-1");
	expect(tokenFor("https://kixel.quest", env)).toBe("theirs");
});

test("logout removes the token, after which a command needing Kixel Quest names quest login", async () => {
	const env = user();
	await login(host(new FakeLogin(), "n", env).deps);
	writeTokens(env, { [KIXEL]: "mine", "https://kixel.quest": "theirs" });
	expect(logout(env)).toEqual({ url: KIXEL, removed: true });
	expect(tokenFor(KIXEL, env)).toBeNull();
	expect(tokenFor("https://kixel.quest", env)).toBe("theirs");
	const deps = { env, fetch, now: () => 0, sleep: async () => {}, github: () => ({}) as never, warn: () => {} };
	expect(() => hostedForge(REPOSITORY, deps)).toThrow(
		`Kixel Quest hosts example/project, but this host is not signed in to ${KIXEL}; run \`quest login\``,
	);
	expect(logout(env)).toEqual({ url: KIXEL, removed: false });
	expect(logout({ ...env, QUEST_KIXEL_URL: "https://kixel.quest" }).removed).toBe(true);
	expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))).toEqual({});
});

test("a token file an earlier quest wrote is moved once, uploading no transcripts", () => {
	const env = user();
	const old = join(dirname(tokensPath(env)), "records.json");
	mkdirSync(dirname(old), { recursive: true });
	writeFileSync(old, JSON.stringify({ [KIXEL]: "pasted", "https://kixel.quest": "theirs" }));
	expect(tokenFor(KIXEL, env)).toBe("pasted");
	expect(JSON.parse(readFileSync(tokensPath(env), "utf8"))).toEqual({
		[KIXEL]: { token: "pasted", transcripts: false },
		"https://kixel.quest": { token: "theirs", transcripts: false },
	});
	expect(existsSync(old)).toBe(false);
	expect(logout(env).removed).toBe(true);
	expect(tokenFor(KIXEL, env)).toBeNull();
});

test("a malformed sign-ins file fails, naming it", () => {
	const env = user();
	mkdirSync(dirname(tokensPath(env)), { recursive: true });
	for (const [content, error] of [
		["{", "is not JSON"],
		["[]", "does not hold an object by Kixel Quest URL"],
		[JSON.stringify({ [KIXEL]: "bare" }), `the sign-in to ${KIXEL} is not {"token"`],
		[JSON.stringify({ [KIXEL]: { token: "t" } }), `the sign-in to ${KIXEL} is not {"token"`],
		[JSON.stringify({ [KIXEL]: { token: "", transcripts: false } }), `the sign-in to ${KIXEL} is not {"token"`],
	]) {
		writeFileSync(tokensPath(env), content!);
		expect(() => tokenFor(KIXEL, env)).toThrow(`${tokensPath(env)}`);
		expect(() => tokenFor(KIXEL, env)).toThrow(error!);
	}
});
