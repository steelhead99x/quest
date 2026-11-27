// The waits `quest gate` and `quest wait` time for the agent session that ran them, and the gate's runs, kept on this
// host so a session's record can add them up. The harness names its session in each command's environment; nothing
// is logged outside one.
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type GatedRun, type SessionWait, WAIT_KINDS } from "../core";

/** A session a harness names in a command's environment. */
export interface EnvSession {
	harness: string;
	session: string;
}

/** One outermost `quest gate` run, as the gate logs it; a record takes its queue and run waits from it. */
export type GateLine = { kind: "gate" } & GatedRun;

/** One logged wait or gate run, with every session its environment named and the directory it ran in. */
export type LoggedWait = (SessionWait | GateLine) & {
	sessions: EnvSession[];
	directory: string;
};

/** Days of logs kept, beyond the longest session a record is expected to span. */
const KEEP_DAYS = 90;
const DAY = 86_400_000;

/**
 * Every session the environment names. A Claude Code sub-agent's commands carry its parent's ID, and an agent one
 * harness starts inherits the other's variable, so a wait may name several; the record builder picks among them.
 */
export function envSessions(env: NodeJS.ProcessEnv = process.env): EnvSession[] {
	const found: EnvSession[] = [];
	if (env.CLAUDE_CODE_SESSION_ID) found.push({ harness: "claude", session: env.CLAUDE_CODE_SESSION_ID });
	if (env.CODEX_THREAD_ID) found.push({ harness: "codex", session: env.CODEX_THREAD_ID });
	return found;
}

/** Where `quest`'s per-session logs on this host live, each one file per UTC day under its own directory. */
export function logDirectory(name: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quest", name);
}

/** Where the waits are logged. */
export const waitsDirectory = (env: NodeJS.ProcessEnv = process.env) => logDirectory("waits", env);

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Append `value` to today's file in `dir` in one write, so concurrent writers leave only whole lines, and drop
 * days past `KEEP_DAYS`. Throws when it cannot write, naming what it logged.
 */
export function appendLog(dir: string, value: unknown, now: number, what: string): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fd = openSync(
			join(dir, `${day(now)}.jsonl`),
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			// A short write, as on a full disk, leaves a line cut short. Starting each record on a fresh line in the
			// same write costs such a fragment only its own record, even when another writer's lands right after it.
			const line = Buffer.from(`\n${JSON.stringify(value)}\n`);
			const written = writeSync(fd, line);
			if (written !== line.length) throw new Error(`wrote ${written} of ${line.length} bytes`);
		} finally {
			closeSync(fd);
		}
		const oldest = day(now - KEEP_DAYS * DAY);
		for (const name of readdirSync(dir))
			if (/^\d{4}-\d\d-\d\d\.jsonl$/.test(name) && name.slice(0, 10) < oldest)
				rmSync(join(dir, name), { force: true });
	} catch (error) {
		throw new Error(`cannot log the ${what} in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The days `dir` holds a file for, as `YYYY-MM-DD`, oldest first. */
export function logDays(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(name))
		.map((name) => name.slice(0, 10))
		.sort();
}

/**
 * The lines in `dir`'s files from `since`'s UTC day on, as `parse` reads each, skipping and reporting on stderr each
 * line it cannot read.
 */
export function readLog<T>(dir: string, since: number, parse: (line: string) => T | null, what: string): T[] {
	return readDays(
		dir,
		logDays(dir).filter((name) => name >= day(since)),
		parse,
		what,
	);
}

/** The lines in `dir`'s files for `days`, as `readLog` reads them. */
export function readDays<T>(dir: string, days: string[], parse: (line: string) => T | null, what: string): T[] {
	const read: T[] = [];
	for (const name of days) {
		const path = join(dir, `${name}.jsonl`);
		readFileSync(path, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (line === "") return;
				const value = parse(line);
				// A short write leaves a line cut short, which no one will repair; one bad line must not stop the rest.
				if (value === null) process.stderr.write(`quest: skipped ${path}:${i + 1}, not ${what} quest logged\n`);
				else read.push(value);
			});
	}
	return read;
}

/** Append `wait` to today's log when the environment names a session. Throws when it cannot write. */
export function logWait(
	wait: SessionWait | GateLine,
	options: { env?: NodeJS.ProcessEnv; cwd?: string; now?: number } = {},
): void {
	const env = options.env ?? process.env;
	const sessions = envSessions(env);
	if (sessions.length === 0) return;
	const logged: LoggedWait = { ...wait, sessions, directory: options.cwd ?? process.cwd() };
	appendLog(waitsDirectory(env), logged, options.now ?? Date.now(), "wait");
}

/** The waits logged on this host that ended at or after `since`, skipping a line it cannot read. */
export function readWaits(since: number, env: NodeJS.ProcessEnv = process.env): LoggedWait[] {
	return readLog(waitsDirectory(env), since, parseLogged, "a wait").filter((w) => Date.parse(w.end) >= since);
}

function parseLogged(line: string): LoggedWait | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const iso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
	const sessions = value?.sessions;
	const shared =
		iso(value?.start) &&
		iso(value.end) &&
		typeof value.directory === "string" &&
		Array.isArray(sessions) &&
		sessions.every((s) => typeof s?.harness === "string" && typeof s?.session === "string");
	if (!shared) return null;
	if (value.kind === "gate")
		return typeof value.command === "string" &&
			(value.admitted === null || iso(value.admitted)) &&
			(value.cpu === null || (typeof value.cpu === "number" && value.cpu >= 0))
			? (value as unknown as LoggedWait)
			: null;
	return WAIT_KINDS.includes(value.kind as SessionWait["kind"]) &&
		(value.until === null || typeof value.until === "string")
		? (value as unknown as LoggedWait)
		: null;
}

/** The kind of a `quest wait` that ended on `event`: the merge queue's when the PR merged or left the queue. */
export function pullWaitKind(event: string | null): SessionWait["kind"] {
	return event === "merged" || event === "removed_from_merge_queue" ? "merge-queue" : "pull";
}
