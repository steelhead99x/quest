// The fake Codex and Claude Code CLIs and the fixture clone the review tests run them in.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";

import { type Output, main } from "../src/cli/main";
import { sessionFile } from "../src/cli/review";
import { tempDir } from "./fixture";
import { writeTokens } from "./kixel-fakes";

/** The Kixel Quest every review run posts to, signed in by `setup`. */
export const KIXEL = "https://kixel.example";

/** The fake CLIs are shebang scripts found on a POSIX PATH, which Windows cannot run. */
export const fakes = test.skipIf(process.platform === "win32");

export const FINDING = {
	file: "src/lib.ts",
	line: 2,
	severity: "high",
	title: "Off by one",
	body: "average([3]) is 0.",
};

export const CODEX_LOGGED_OUT =
	"codex is not logged in to its default profile (CODEX_HOME is unset); run `codex login`";
export const CLAUDE_LOGGED_OUT =
	"claude is not logged in to its default profile (CLAUDE_CONFIG_DIR is unset); run `claude auth login`";

/**
 * The findings turn's reply, `reply`: FAKE_REPLY, or one finding. A JSON reply without `earlier` settles
 * each earlier finding the prompt numbers as FAKE_DISPOSITION says, `fixed` by default.
 */
const REPLY = `
const listed = /<earlier-findings>\\n([\\s\\S]*?)\\n<\\/earlier-findings>/.exec(stdin)?.[1] ?? "";
const earlier = [...listed.matchAll(/^(\\d+)\\. /gm)].map((m) => ({
	finding: Number(m[1]),
	disposition: process.env.FAKE_DISPOSITION ?? "fixed",
	reason: "Checked against the head.",
}));
let reply = process.env.FAKE_REPLY ?? JSON.stringify({ score: 8, rationale: "Lands once the off-by-one is fixed.", findings: [${JSON.stringify(FINDING)}] });
try {
	const parsed = JSON.parse(reply);
	if (parsed && typeof parsed === "object" && !("earlier" in parsed)) reply = JSON.stringify({ ...parsed, earlier });
	if (parsed && typeof parsed === "object" && !("recommendation" in parsed)) reply = JSON.stringify({ ...JSON.parse(reply), recommendation: null });
} catch {}
`;

/** The classifier's reply: FAKE_RISK, or medium. */
const RISK_REPLY = `JSON.stringify(process.env.FAKE_RISK ? JSON.parse(process.env.FAKE_RISK) : { tier: "medium", reason: "It changes what the library returns." })`;

/**
 * Records one call as its own file in FAKE_LOG, a directory, renamed into place
 * once whole, named by its microsecond start so the files sort in call order. A
 * fake the review aborts can die mid-write, and a partial line in one shared
 * log would break the reader.
 */
const LOG = `
const logged = (call) => {
	const name = Math.round((performance.timeOrigin + performance.now()) * 1000).toString() + "-" + process.pid;
	const file = require("node:path").join(process.env.FAKE_LOG, name);
	fs.writeFileSync(file + ".tmp", JSON.stringify(call));
	fs.renameSync(file + ".tmp", file + ".json");
};
`;

/**
 * Fake reviewer CLIs. Each logs its argv, stdin, and the variables it was
 * given, then answers as the FAKE_* variables say. FAKE_LOGGED_OUT removes the
 * stored login, so only a credential variable the real CLI reads, or Claude
 * Code's switch to a cloud provider, authenticates; like the real ones,
 * `claude auth status` counts such a variable, and `codex login status` counts
 * CODEX_ACCESS_TOKEN but not CODEX_API_KEY. FAKE_REJECTED has the API
 * reject the login in each turn with the real CLI's error, in the style it
 * names. FAKE_LIMITED fails a turn on the account's usage limit with the real
 * CLI's error, naming its reset unless set to `unknown`. FAKE_CLASSIFY fails
 * the classifier's turn of each `<harness>-rejected` or `<harness>-limited` it
 * lists, the same way. FAKE_FAILS limits FAKE_LOGGED_OUT, FAKE_REJECTED, and
 * FAKE_LIMITED to the harnesses and models it lists, comma-separated, so one
 * reviewer fails while the next runs. FAKE_QUOTED fails Claude Code's findings
 * turn with a reply that only quotes a limit's message. FAKE_REPLY replaces the
 * findings reply. FAKE_HANG_CLAUDE, a FIFO's path, hangs Claude Code's review turn until it is stopped, as a seat still
 * running when another's failure cancels it, after signalling on the FIFO, which Codex's limit waits to read before
 * failing, so the limit never lands before that turn starts. FAKE_HANG_CODEX, a FIFO's path, does the same to Codex's, after it opened its thread and
 * signalled on the FIFO, which Claude Code's limit waits to read before failing, so the limit never lands first.
 */
export const FAKES: Record<string, string> = {
	claude: `
const fs = require("node:fs");${LOG}
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE_HOST|PATH$)/.test(k)));
// The directory --add-dir lets it read, as it stood.
const extra = argv.includes("--add-dir") ? argv[argv.indexOf("--add-dir") + 1] : undefined;
const readable = extra && Object.fromEntries(fs.readdirSync(extra).map((name) => [name, fs.readFileSync(require("node:path").join(extra, name), "utf8")]));
logged({ argv, stdin, env, cwd: process.cwd(), readable });
// FAKE_FAILS limits the FAKE_* failures to the harnesses and models it lists.
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : argv.includes("-m") ? argv[argv.indexOf("-m") + 1] : undefined;
const only = process.env.FAKE_FAILS?.split(",");
const fake = (name) => (!only || only.includes("claude") || only.includes(model) ? process.env[name] : undefined);
const credential = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some((k) => process.env[k]);
const provider = Object.entries(process.env).some(([k, v]) => k.startsWith("CLAUDE_CODE_USE_") && v === "1");
const loggedIn = !fake("FAKE_LOGGED_OUT") || credential || provider;
if (argv[0] === "auth") process.exit(loggedIn ? 0 : 1);
const at = (flag) => argv[argv.indexOf(flag) + 1];
if (process.env.FAKE_HANG_CLAUDE && argv.includes("--session-id") && !argv.includes("--json-schema")) {
	fs.writeFileSync(process.env.FAKE_HANG_CLAUDE, "");
	setInterval(() => {}, 1000);
	return;
}
const result = (fields) => console.log(JSON.stringify({ type: "result", is_error: false, ...fields }));
const rejected = fake("FAKE_REJECTED") ?? (loggedIn ? undefined : "status");
if (rejected) {
	const session_id = at("--session-id") ?? at("--resume");
	if (rejected === "status") {
		result({ session_id, is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 Invalid bearer token" });
	} else if (rejected === "stderr") {
		console.error("Login expired · Please run /login");
	} else {
		result({ session_id, is_error: true, result: "OAuth token revoked · Please run /login" });
	}
	process.exit(1);
}
// A turn that fails without the CLI's error, its reply only quoting a limit's message.
if (process.env.FAKE_QUOTED && argv.includes("--resume")) {
	result({ session_id: at("--resume"), result: "The diff prints: You've hit your weekly limit · resets Nov 5, 3pm (UTC)" });
	process.exit(1);
}
// The limit hits the findings turn, after the review turn passed.
if (fake("FAKE_LIMITED") && argv.includes("--resume")) {
	// A read of the FIFO blocks until Codex's thread is open, with nothing to poll.
	if (process.env.FAKE_HANG_CODEX) fs.readFileSync(process.env.FAKE_HANG_CODEX);
	if (fake("FAKE_LIMITED") !== "unknown") {
		console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } }));
	}
	result({ session_id: at("--resume"), is_error: true, result: "You've hit your weekly limit · resets Nov 5, 3pm (UTC)" });
	process.exit(1);
}
const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
const failing = (process.env.FAKE_CLASSIFY ?? "").split(",");
if (argv.includes("--session-id") && argv.includes("--json-schema")) {
	if (failing.includes("claude-rejected")) {
		result({ session_id: at("--session-id"), is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 Invalid bearer token" });
		process.exit(1);
	}
	if (failing.includes("claude-limited")) {
		console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } }));
		result({ session_id: at("--session-id"), is_error: true, result: "You've hit your weekly limit · resets Nov 5, 3pm (UTC)" });
		process.exit(1);
	}
	const reply = failing.includes("claude-unusable") ? JSON.stringify({ tier: "huge", reason: "x" }) : ${RISK_REPLY};
	result({
		session_id: at("--session-id"),
		result: reply,
		structured_output: JSON.parse(reply),
		usage: { ...usage, input_tokens: 40, output_tokens: 3 },
	});
} else if (argv.includes("--session-id")) {
	result({
		session_id: at("--session-id"),
		result: "Found an off-by-one.",
		usage,
		modelUsage: {
			"claude-small": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
			"claude-big": { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 90 },
		},
	});
} else {
	${REPLY}
	result({
		session_id: at("--resume"),
		result: reply,
		structured_output: process.env.FAKE_REPLY ? undefined : JSON.parse(reply),
		usage: { ...usage, input_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 15, output_tokens: 7 },
		modelUsage: { "claude-big": { inputTokens: 15, outputTokens: 57 } },
	});
}
`,
	codex: `
const fs = require("node:fs");${LOG}
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE_HOST|PATH$)/.test(k)));
logged({ argv, stdin, env, cwd: process.cwd() });
// FAKE_FAILS limits the FAKE_* failures to the harnesses and models it lists.
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : argv.includes("-m") ? argv[argv.indexOf("-m") + 1] : undefined;
const only = process.env.FAKE_FAILS?.split(",");
const fake = (name) => (!only || only.includes("codex") || only.includes(model) ? process.env[name] : undefined);
if (argv[0] === "login") process.exit(fake("FAKE_LOGGED_OUT") && !process.env.CODEX_ACCESS_TOKEN ? 1 : 0);
// FAKE_HANG hangs the first turn until it is stopped, writing its pid there, and lets later turns run.
if (process.env.FAKE_HANG && !fs.existsSync(process.env.FAKE_HANG)) {
	// It takes a while to exit when asked to, as a CLI saving its session does.
	process.on("SIGTERM", () => setTimeout(() => process.exit(143), 300));
	fs.writeFileSync(process.env.FAKE_HANG, String(process.pid));
	setInterval(() => {}, 1000);
	return;
}
const event = (value) => console.log(JSON.stringify(value));
if (process.env.FAKE_HANG_CODEX) {
	event({ type: "thread.started", thread_id: "thread-1" });
	fs.writeFileSync(process.env.FAKE_HANG_CODEX, "");
	setInterval(() => {}, 1000);
	return;
}
const loggedIn = !fake("FAKE_LOGGED_OUT") || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN;
const rejected = fake("FAKE_REJECTED") ?? (loggedIn ? undefined : "turn");
if (rejected === "turn") {
	const message = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
	event({ type: "thread.started", thread_id: "thread-1" });
	event({ type: "error", message: "Reconnecting... 1/5 (" + message + ")" });
	event({ type: "turn.failed", error: { message } });
	process.exit(1);
}
if (rejected) {
	console.error("Error: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.");
	process.exit(1);
}
if (fake("FAKE_LIMITED")) {
	// A read of the FIFO blocks until Claude's review turn is running, with nothing to poll.
	if (process.env.FAKE_HANG_CLAUDE) fs.readFileSync(process.env.FAKE_HANG_CLAUDE);
	const message = fake("FAKE_LIMITED") === "retried"
		? "exceeded retry limit, last status: 429 Too Many Requests"
		: fake("FAKE_LIMITED") === "unknown"
		? "You've hit your usage limit."
		: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 3:15 PM.";
	event({ type: "thread.started", thread_id: "thread-1" });
	event({ type: "error", message });
	event({ type: "turn.failed", error: { message } });
	process.exit(1);
}
const message = (text) => event({ type: "item.completed", item: { type: "agent_message", text } });
const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
if (argv[1] === "review") {
	event({ type: "thread.started", thread_id: "thread-1" });
	message("Found an off-by-one.");
	event({ type: "turn.completed", usage: zero });
} else if (argv[1] !== "resume") {
	event({ type: "thread.started", thread_id: "thread-classify" });
	const failing = (process.env.FAKE_CLASSIFY ?? "").split(",");
	if (failing.includes("codex-rejected")) {
		event({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } });
		process.exit(1);
	}
	if (failing.includes("codex-limited")) {
		const message = "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 3:15 PM.";
		event({ type: "turn.failed", error: { message } });
		process.exit(1);
	}
	message(failing.includes("codex-unusable") ? "not JSON" : ${RISK_REPLY});
	event({ type: "turn.completed", usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 3 } });
} else {
	event({ type: "thread.started", thread_id: argv[argv.length - 2] });
	message("Checking the findings.");
	${REPLY}
	message(reply);
	event({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } });
}
`,
};

export const git = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], {
		encoding: "utf8",
	}).trim();

export function write(dir: string, path: string, text: string) {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}

export interface Setup {
	repo: string;
	bin: string;
	/** Every logged invocation of the fake Codex and Claude Code. */
	calls(): Call[];
}

export interface Call {
	argv: string[];
	stdin: string;
	env: Record<string, string>;
	cwd: string;
	/** The files of the directory a Claude Code turn was let read beside the checkout, as they stood. */
	readable?: Record<string, string> | undefined;
}

/** Credentials and routes the running session may hold, cleared so each test sets its own. */
const HOST_CREDENTIALS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
	...["BEDROCK", "VERTEX", "FOUNDRY", "MANTLE", "ANTHROPIC_AWS", "ANTHROPIC_GOOGLE_CLOUD"].map(
		(provider) => `CLAUDE_CODE_USE_${provider}`,
	),
	"CODEX_API_KEY",
	"CODEX_ACCESS_TOKEN",
	"CODEX_CA_CERTIFICATE",
];

/**
 * A clone whose origin's main holds instructions and review rules, checked out
 * on a branch that edits its own AGENTS.md and a file in `src/`.
 */
export function setup(host: "CLAUDECODE" | "CODEX_THREAD_ID" | null = "CLAUDECODE"): Setup {
	const dir = tempDir();
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, body] of Object.entries(FAKES)) {
		writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
		chmodSync(join(bin, name), 0o755);
	}
	const origin = join(dir, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	const repo = join(dir, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	write(repo, "AGENTS.md", "BASE-ROOT rule\n");
	write(repo, "src/AGENTS.md", "BASE-SRC rule\n");
	write(repo, "docs/AGENTS.md", "BASE-DOCS rule\n");
	write(repo, "REVIEW.md", "BASE-REVIEW rule\n");
	write(repo, "src/lib.ts", "export const x = 1;\n");
	write(repo, ".gitignore", ".tmp/\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	git(repo, "checkout", "-qb", "feature");
	write(repo, "AGENTS.md", "HEAD-ROOT rule\n");
	write(repo, "src/lib.ts", "export const x = 2;\n");
	git(repo, "commit", "-qam", "change");

	const log = join(dir, "calls");
	mkdirSync(log);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	vi.stubEnv("FAKE_LOG", log);
	// The session's own profile would change the logged-out errors.
	const unset = [
		...HOST_CREDENTIALS,
		"CLAUDECODE",
		"CODEX_THREAD_ID",
		"CLAUDE_CONFIG_DIR",
		"CODEX_HOME",
		"OPENAI_BASE_URL",
	];
	for (const name of [
		...unset,
		"FAKE_LOGGED_OUT",
		"FAKE_REJECTED",
		"FAKE_LIMITED",
		"FAKE_FAILS",
		"FAKE_QUOTED",
		"FAKE_HANG",
		"FAKE_DISPOSITION",
		"FAKE_RISK",
		"FAKE_CLASSIFY",
	]) {
		vi.stubEnv(name, undefined);
	}
	// Every run that records posts to Kixel Quest, so the host is signed in.
	const config = join(dir, "config");
	vi.stubEnv("XDG_CONFIG_HOME", config);
	vi.stubEnv("QUEST_KIXEL_URL", KIXEL);
	vi.stubEnv("QUEST_FORGE", undefined);
	writeTokens({ XDG_CONFIG_HOME: config }, { [KIXEL]: "secret" });
	if (host === "CLAUDECODE") vi.stubEnv("CLAUDECODE", "1");
	if (host === "CODEX_THREAD_ID") vi.stubEnv("CODEX_THREAD_ID", "parent");
	// Only whole calls: a fake's unfinished write stays a .tmp file.
	const read = (path: string) =>
		readdirSync(path)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.map((name) => JSON.parse(readFileSync(join(path, name), "utf8")));
	return { repo, bin, calls: () => read(log) };
}

/**
 * Classify `s`'s head with the fakes as they stand and keep only that classification, which a later round on the same
 * head reuses, so a test of how the reviewers' CLIs run sees no classifier turn and no earlier round.
 */
export async function classified(s: Setup): Promise<void> {
	const first = await quest("--root", s.repo, "review");
	if (first.code !== 0) throw new Error(first.stderr);
	const path = sessionFile(join(s.repo, ".git"), "feature");
	const { branch, classified } = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ branch, sessions: [], tallies: [], classified }));
	const log = join(s.bin, "..", "calls");
	for (const name of readdirSync(log)) rmSync(join(log, name));
}

/** The effort a Codex or Claude Code turn runs at, or null for a status check. */
export function effortOf(call: Call): string | null {
	const flag = call.argv.indexOf("--effort");
	if (flag >= 0) return call.argv[flag + 1]!;
	const setting = call.argv.find((arg) => arg.startsWith("model_reasoning_effort="));
	return setting ? JSON.parse(setting.slice("model_reasoning_effort=".length)) : null;
}

/** The turns at `effort`, so two seats on the same CLI read apart. */
export const at = (calls: Call[], effort: string) => calls.filter((call) => effortOf(call) === effort);

export const quest = (...args: string[]) => questFrom(undefined, ...args);

/** Run the CLI as the quest executing from `entry`, as `bin.ts` reports it. */
export async function questFrom(
	entry: string[] | undefined,
	...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const out: Output = {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		entry,
	};
	const code = await main(args, out);
	return { code, stdout, stderr };
}
