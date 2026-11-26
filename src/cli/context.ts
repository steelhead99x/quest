// On-demand context packs (`quest context <pack>`) and lazy once-per-session
// injection from `quest hook` so language and PR rules pay no startup token tax.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import pr from "../../assets/context/pr.md";
import review from "../../assets/REVIEW.md";
import rust from "../../assets/context/rust.md";
import ts from "../../assets/context/ts.md";
import uniffi from "../../assets/context/uniffi.md";
import { questCommand, shellCommands } from "./rules";
import { logDirectory } from "./waits";

/** Shared base review rules loaded by `quest review` before a repository's own `REVIEW.md`. */
export const REVIEW: string = review;

/** One on-demand context pack: its name, summary, and Markdown rules. */
export interface ContextPack {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** Every context pack Quest ships, sorted by name. */
export const CONTEXT_PACKS: readonly ContextPack[] = [
	{ name: "pr", description: "Pull request hygiene, review records, and culprit attribution", body: pr },
	{ name: "review", description: "Shared adversarial code review rules", body: review },
	{ name: "rust", description: "Rust crate conventions, async polls, semver, and testing", body: rust },
	{ name: "ts", description: "TypeScript/Bun boundaries, teardown, packaging, and browser verification", body: ts },
	{ name: "uniffi", description: "UniFFI exports, cross-language wrappers, and Python bindings", body: uniffi },
];

/** The pack called `name` (case-insensitive), or throws listing the available packs. */
export function contextPack(name: string): ContextPack {
	const found = CONTEXT_PACKS.find((pack) => pack.name === name.trim().toLowerCase());
	if (!found) {
		throw new Error(`no context pack named ${name} (have: ${CONTEXT_PACKS.map((p) => p.name).join(", ")})`);
	}
	return found;
}

/** The named packs joined in canonical order, deduplicated. */
export function contextPacks(names: readonly string[]): string {
	const wanted = new Set(names.map((name) => contextPack(name).name));
	return `${CONTEXT_PACKS.filter((pack) => wanted.has(pack.name))
		.map((pack) => pack.body.trim())
		.join("\n\n")}\n`;
}

const RUST_EXTS = new Set([".rs"]);
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".svelte", ".js", ".jsx", ".mjs", ".cjs"]);
const UNIFFI_PATH = /(^|[/_-])(uniffi|ffi)([/_.-]|$)|\.udl$/i;

/** The context packs relevant to a file path being created or edited. */
function packsForPath(path: string, found: Set<string>): void {
	const base = basename(path);
	const ext = extname(base).toLowerCase();
	if (RUST_EXTS.has(ext) || base === "Cargo.toml") found.add("rust");
	if (TS_EXTS.has(ext) || base === "package.json" || base === "tsconfig.json") found.add("ts");
	if (UNIFFI_PATH.test(path)) found.add("uniffi");
}

/** File paths targeted by Codex's `apply_patch` command text. */
function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split("\n")) {
		const header = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line);
		if (header) paths.push(header[1]!.trim());
	}
	return paths;
}

/** Whether a shell command interacts with pull requests (`gh pr`, `quest pr|ready|merge|review`). */
function touchesPr(command: string): boolean {
	for (const argv of shellCommands(command)) {
		const [cmd, ...args] = argv;
		const name = basename(cmd!);
		if (name === "gh" && args[0] === "pr") return true;
		if (name === "quest" && ["pr", "ready", "merge", "review"].includes(questCommand(args)[0] ?? "")) return true;
	}
	return false;
}

/** The context pack names triggered by a `PreToolUse` tool call, in canonical order. */
export function packsForToolCall(tool: string, input: Record<string, unknown>): string[] {
	const found = new Set<string>();
	const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	switch (tool) {
		case "Write":
		case "Edit":
		case "MultiEdit": {
			const path = text("file_path");
			if (path !== undefined) packsForPath(path, found);
			break;
		}
		case "apply_patch": {
			const patch = text("command");
			if (patch !== undefined) for (const path of patchPaths(patch)) packsForPath(path, found);
			break;
		}
		case "Bash": {
			const command = text("command");
			if (command !== undefined && touchesPr(command)) found.add("pr");
			break;
		}
	}
	return CONTEXT_PACKS.filter((pack) => found.has(pack.name)).map((pack) => pack.name);
}

/** Days of per-session pack injection state retained before cleanup. */
const KEEP_MS = 7 * 86_400_000;

/** Safe filename for one session (or subagent) under the context state directory. */
function stateFile(session: string, agent: string | null, env: NodeJS.ProcessEnv): string {
	const raw = agent ? `${session}__${agent}` : session;
	const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(logDirectory("context", env), `${safe}.json`);
}

/** Clear recorded pack injections for a session, e.g. on startup, clear, or compact. */
export function resetSessionPacks(session: string, agent: string | null, env: NodeJS.ProcessEnv = process.env): void {
	if (!session) return;
	try {
		rmSync(stateFile(session, agent, env), { force: true });
	} catch {
		// Nothing to clear when the state directory does not exist yet.
	}
}

/**
 * Filter `packs` to those not yet injected for `(session, agent)`, persist the
 * updated set, and return the newly claimed pack names. Without a session ID,
 * returns `[]` so stateless calls don't spam every invocation.
 */
export function claimSessionPacks(
	session: string | undefined,
	agent: string | null,
	packs: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): string[] {
	if (!session || packs.length === 0) return [];
	const dir = logDirectory("context", env);
	const file = stateFile(session, agent, env);
	let seen = new Set<string>();
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { packs?: unknown };
			if (Array.isArray(parsed.packs))
				seen = new Set(parsed.packs.filter((p): p is string => typeof p === "string"));
		} catch {
			// Treat a corrupt state file as empty and overwrite it below.
		}
	}
	const fresh = packs.filter((pack) => !seen.has(pack));
	if (fresh.length === 0) return [];
	for (const pack of fresh) seen.add(pack);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify({ updatedAt: now, packs: [...seen].sort() }), { mode: 0o600 });
	// Prune stale session files opportunistically.
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		if (path === file) continue;
		try {
			const entry = JSON.parse(readFileSync(path, "utf8")) as { updatedAt?: unknown };
			if (typeof entry.updatedAt === "number" && now - entry.updatedAt > KEEP_MS) rmSync(path, { force: true });
		} catch {
			rmSync(path, { force: true });
		}
	}
	return fresh;
}
