// `quest messages`: the messages a person typed to their agents on this host, and their answers to agents' blocking
// questions, and nothing an agent or harness wrote. Each source marks its sender: T3 Code's state for the sessions it
// drives, Claude Code's `origin` for the rest of its sessions, and Codex's content provenance for its interactive ones.
// Answers come from each harness's own log, which keeps the question's options. Output goes to stdout only.
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostedRepository, originHost } from "./forge";
import { type Remote, type RemoteHost, readRemote, remoteHost, urlHost } from "./github";
import { RECOMMENDED, checkoutRoot } from "./rules";
import { kixelUrl } from "./tokens";

/**
 * Visit each line of the file at `path`, reading it in bounded chunks since logs reach gigabytes. The last line is
 * marked incomplete when no newline ends it, as while its session is still writing it. Reading stops once `visit`
 * returns false.
 */
export function eachLine(path: string, visit: (line: string, complete: boolean) => boolean | void): void {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(1 << 22);
		let rest = Buffer.alloc(0);
		for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
			const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
			let start = 0;
			for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
				if (end > start && visit(data.toString("utf8", start, end), true) === false) return;
				start = end + 1;
			}
			rest = Buffer.from(data.subarray(start));
		}
		if (rest.length) visit(rest.toString("utf8"), false);
	} finally {
		closeSync(fd);
	}
}

/**
 * One JSON record of a log line, or null for an incomplete last line. With `skip`, a complete line that is not JSON,
 * such as a partial record a crashed write left mid-file, is counted through it and read as null instead of failing.
 */
export function parseLine(
	path: string,
	line: string,
	complete: boolean,
	skip?: () => void,
): Record<string, unknown> | null {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch (error) {
		if (!complete) return null;
		if (skip) {
			skip();
			return null;
		}
		throw new Error(`${path} has a line that is not JSON: ${(error as Error).message}`);
	}
}

/** Claude Code's session logs by session ID, from each config directory Claude Code uses, once each. */
function claudeLogs(deps: { env: NodeJS.ProcessEnv; home: string }): Map<string, string> {
	const configured = deps.env.CLAUDE_CONFIG_DIR?.split(",")
		.map((dir) => dir.trim())
		.filter(Boolean);
	const dirs = configured?.length ? configured : [join(deps.home, ".config", "claude"), join(deps.home, ".claude")];
	const logs = new Map<string, string>();
	for (const dir of dirs) {
		const projects = join(dir, "projects");
		if (!existsSync(projects)) continue;
		for (const project of readdirSync(projects, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			for (const file of readdirSync(join(projects, project.name)))
				if (file.endsWith(".jsonl") && !logs.has(file.slice(0, -6)))
					logs.set(file.slice(0, -6), join(projects, project.name, file));
		}
	}
	return logs;
}

/** One message a person typed. */
export interface Message {
	kind: "message";
	/** ISO 8601 UTC. */
	time: string;
	/** `claude`, `codex`, or the agent T3 Code names; null when T3 Code recorded no agent for the turn. */
	harness: string | null;
	/** The repository as `MessagesQuery.repository` names it. */
	repository: string;
	/** The harness's own session ID, or null when T3 Code recorded none. */
	session: string | null;
	text: string;
}

/** One question an agent asked and blocked on, with the person's answer. */
export interface Answer {
	kind: "answer";
	/** ISO 8601 UTC, when the answer came back. */
	time: string;
	harness: string;
	repository: string;
	session: string;
	/** The skill the session last ran before asking, when its log names one. */
	skill: string | null;
	/** The question's short label, when the harness has one. */
	header: string | null;
	question: string;
	options: string[];
	/** The options the agent marked `(Recommended)`. */
	recommended: string[];
	/** The options picked, or the person's own words when they typed an answer instead. */
	picked: string[];
}

/** What `quest messages` prints. */
export type Entry = Message | Answer;

/** Which messages `messages` returns: those since a local `YYYY-MM-DD`, from one repository or, when null, every one. */
export interface MessagesQuery {
	since: string;
	/** A repository as the output names it, `owner/name` on GitHub, `<host>/owner/name` on Kixel Quest, else its directory; null for all. */
	repository: string | null;
}

/** How the readers name the repository a session ran in. */
export interface Repositories {
	/** The repository the directory `dir`, where `session` ran, belongs to, as the output names it. */
	name(dir: string, session?: string): string;
	/** The repository a recorded origin URL names on either forge, as `name` would, or null for neither. */
	origin(url: string): string | null;
	/**
	 * Whether `repository` is the one the checkout naming `dir`, where `session` ran, names by its configured origin
	 * or by the URL git fetches that origin from, after `insteadOf` rewrites.
	 */
	names(dir: string, session: string | undefined, repository: string): boolean;
}

export interface MessagesDependencies {
	env: NodeJS.ProcessEnv;
	home: string;
	/** Told, on stderr, of each Claude Code session whose malformed lines were skipped, and of the repositories left out. */
	warn?: (line: string) => void;
}

/** T3 Code drives these sessions and records who sent each message, so they are read from its state instead. */
const T3_CLAUDE = "t3-code";
const T3_CODEX = "T3 Code";

/** Wrappers Claude Code puts on a typed turn that hold output or a button's canned prompt, not the person's words. */
const CLAUDE_OUTPUT =
	/^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|create-pr-command)>/;

/** The typed text of a Claude Code user turn: reminders the harness added dropped, a slash command as typed. */
export function claudeText(content: unknown): string | null {
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		if (content.some((block) => block?.type === "tool_result")) return null;
		text = content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("\n");
	} else return null;
	text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
	if (command) {
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
		text = `${command[1]!.trim()} ${args.trim()}`;
	}
	text = text.trim();
	return text === "" || CLAUDE_OUTPUT.test(text) ? null : text;
}

/**
 * Worktrees Claude Code and quest keep inside the checkout they belong to, so a removed one is named by that checkout.
 * No other missing directory is: its nearest existing ancestor can be an unrelated checkout, such as a home directory.
 */
const WORKTREE = /^(.+?)[/\\](?:\.claude[/\\]worktrees|\.worktrees)[/\\][^/\\]+(?:[/\\].*)?$/;

/** A repository's name as the query compares it: both forges ignore case in their names, a directory keeps it. */
const folded = (name: string) => (isAbsolute(name) ? name : name.toLowerCase());

/**
 * Names each directory's repository by its checkout's configured `origin`, before `insteadOf` rewrites, as
 * `owner/name` on GitHub or `<host>/owner/name` on Kixel Quest, so the same name on both forges differs, else the
 * directory itself, or for a session T3 Code drives in a worktree it removed, its project's. `projects` maps each T3
 * Code session to its project.
 */
export function repositories(
	env: NodeJS.ProcessEnv,
	projects: ReadonlyMap<string, T3Project> = new Map(),
): Repositories {
	const kixel = kixelUrl(env);
	const named = (host: RemoteHost | null) => forgeName(host, kixel);
	const hosted = (url: string) => hostedRepository(kixel, url);
	// By checkout, so its subdirectories and removed worktrees share one lookup: the repository its origin names, as
	// `remoteHost` picks it, and the names of its configured URL and of the URL git uses, case-folded.
	const origins = new Map<string, { name: string | null; aliases: string[] }>();
	const origin = (checkout: string) => {
		let found = origins.get(checkout);
		if (found === undefined) {
			let remote: Remote | null = null;
			let used: string | null = null;
			try {
				remote = readRemote(checkout, "origin");
				used = remote?.used().fetch ?? null;
			} catch {
				// A directory git cannot read, such as a worktree whose repository moved or whose origin is removed
				// while it is read, is named by itself: a session's recorded directory is history, not input to validate.
				remote = null;
			}
			const urls = remote === null || used === null ? [] : [remote.configured.fetch, used];
			found = {
				name: remote === null ? null : named(remoteHost(remote, hosted)),
				aliases: urls.flatMap((url) => {
					const one = named(urlHost(url, hosted));
					return one === null ? [] : [folded(one)];
				}),
			};
			origins.set(checkout, found);
		}
		return found;
	};
	// By directory, the checkout that names it, if any, and whether the directory is gone.
	const checkouts = new Map<string, string | null>();
	const removed = new Set<string>();
	const checkout = (dir: string): string | null => {
		let found = checkouts.get(dir);
		if (found === undefined) {
			// The physical directory, as git would find it: a symlink's own parents can be another checkout.
			const real = physical(dir);
			if (real === null) removed.add(dir);
			const root = real !== null ? checkoutRoot(real) : WORKTREE.exec(dir)?.[1];
			found = root !== undefined && existsSync(root) ? root : null;
			checkouts.set(dir, found);
		}
		return found;
	};
	// The directory whose checkout names `dir`: T3 Code removes its worktrees, which sit outside the checkout, but keeps
	// their project and path. A directory that still exists is what it is, even unnamed, and one outside the session's
	// worktree, such as where a person resumed it, is not the project's.
	const source = (dir: string, session: string | undefined): string => {
		const own = checkout(dir);
		if (own !== null && origin(own).name !== null) return dir;
		const project = session === undefined ? undefined : projects.get(session);
		const inside = (root: string | null) => root !== null && (dir === root || dir.startsWith(`${root}${sep}`));
		return project !== undefined && removed.has(dir) && inside(project.worktree) ? project.root : dir;
	};
	const name = (dir: string): string => {
		const own = checkout(dir);
		return (own === null ? null : origin(own).name) ?? dir;
	};
	return {
		name: (dir, session) => name(source(dir, session)),
		origin: (url) => named(urlHost(url, hosted)),
		names(dir, session, repository) {
			const own = checkout(source(dir, session));
			return own !== null && origin(own).aliases.includes(folded(repository));
		},
	};
}

/**
 * The physical path of `dir`, or null when it cannot be resolved, as when its worktree is removed while being read or
 * a directory on its path became a file: a session's recorded directory is history, not input to validate.
 */
function physical(dir: string): string | null {
	try {
		return realpathSync(dir);
	} catch {
		return null;
	}
}

/** A repository on either forge as the output names it, or null for none. */
function forgeName(host: RemoteHost | null, kixel: string): string | null {
	if (host === null) return null;
	const { owner, repo } = host.repository;
	return host.forge === "kixel" ? `${new URL(kixel).host}/${owner}/${repo}` : `${owner}/${repo}`;
}

/**
 * The repository the checkout holding the existing directory `dir` names, as the output names it, or null when its
 * origin names neither forge. Unlike `Repositories.name`, it never names a missing directory by its history.
 */
export function checkoutRepository(dir: string, env: NodeJS.ProcessEnv): string | null {
	return forgeName(originHost(checkoutRoot(realpathSync(dir)), env), kixelUrl(env));
}

/** Files under `dir` with `.jsonl` names written since `since`, recursively; a log untouched since holds nothing newer. */
function logsSince(dir: string, since: number): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return logsSince(path, since);
		return entry.name.endsWith(".jsonl") && statSync(path).mtimeMs >= since ? [path] : [];
	});
}

/** The answer entries for one question, given its options and what was picked. */
function answer(
	base: Omit<Answer, "kind" | "question" | "header" | "options" | "recommended" | "picked">,
	question: string,
	header: string | null,
	options: string[],
	picked: string[],
): Answer {
	return {
		kind: "answer",
		...base,
		header,
		question,
		options,
		recommended: options.filter((option) => RECOMMENDED.test(option)),
		picked,
	};
}

/** How Claude Code opens the turn loading a skill, whether typed as a slash command or called as a tool. */
const CLAUDE_SKILL = /^\s*Base directory for this skill: (?:.*\/)?([^/\n]+?)\/?[ \t]*$/m;

/** The skill a Claude Code record loads, if any; built-in commands such as `/compact` load none. */
export function claudeSkill(record: Record<string, unknown>): string | null {
	const content = (record.message as { content?: unknown } | undefined)?.content;
	if (record.type !== "user" || record.isMeta !== true || !Array.isArray(content)) return null;
	for (const block of content) {
		const name = typeof block?.text === "string" ? CLAUDE_SKILL.exec(block.text)?.[1] : undefined;
		if (name) return name;
	}
	return null;
}

/**
 * A Claude Code log's typed turns, outside sessions T3 Code drives, and its answers to `AskUserQuestion`, in every
 * session, since T3 Code keeps no question's options. A sub-agent's turns are never a person's.
 */
export function readClaudeMessages(
	path: string,
	session: string,
	since: number,
	repositories: Repositories,
	skip?: () => void,
): Entry[] {
	const entries: Entry[] = [];
	let skill: string | null = null;
	eachLine(path, (line, complete) => {
		// Only these lines can hold a typed turn, a skill, or an answer; the rest are parsed only to count malformed ones.
		if (
			!line.includes('"human"') &&
			!line.includes("Base directory for this skill") &&
			!line.includes('"answers"')
		) {
			if (skip) parseLine(path, line, complete, skip);
			return;
		}
		const record = parseLine(path, line, complete, skip);
		if (!record || record.isSidechain === true) return;
		const result = record.toolUseResult as Record<string, unknown> | undefined;
		const human = (record.origin as { kind?: unknown } | undefined)?.kind === "human";
		skill = claudeSkill(record) ?? skill;
		const asked = record.type === "user" && Array.isArray(result?.questions) && result.answers !== undefined;
		if (!asked && (record.type !== "user" || !human)) return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user record without a timestamp`);
		if (at < since) return;
		if (typeof record.cwd !== "string") throw new Error(`${path} has a user record without a directory`);
		const base = {
			time: new Date(at).toISOString(),
			harness: "claude",
			repository: repositories.name(record.cwd, session),
			session,
		};
		if (asked) {
			const answers = result!.answers as Record<string, unknown>;
			if (typeof answers !== "object" || answers === null)
				throw new Error(`${path} has answers in a shape quest does not know`);
			for (const q of result!.questions as Record<string, unknown>[]) {
				const options = Array.isArray(q?.options)
					? q.options.map((o) => (o as { label?: unknown })?.label)
					: null;
				if (typeof q?.question !== "string" || !options?.every((o): o is string => typeof o === "string"))
					throw new Error(`${path} has a question in a shape quest does not know`);
				const given = answers[q.question];
				// A question the person left unanswered has no entry.
				if (given === undefined) continue;
				const picked = typeof given === "string" ? [given] : given;
				if (!Array.isArray(picked) || !picked.every((p) => typeof p === "string"))
					throw new Error(`${path} has an answer in a shape quest does not know`);
				entries.push(
					answer(
						{ ...base, skill },
						q.question,
						typeof q.header === "string" ? q.header : null,
						options,
						picked,
					),
				);
			}
			return;
		}
		if (record.entrypoint === T3_CLAUDE || record.isMeta === true) return;
		const text = claudeText((record.message as { content?: unknown } | undefined)?.content);
		if (text !== null) entries.push({ kind: "message", ...base, text });
	});
	return entries;
}

/** Codex's tools that block on a person's answer: the first returns it, the second has it sent as a later turn. */
export const CODEX_ASK = new Set(["request_user_input", "request_user_input_async"]);

/** The turn part carrying answers to `request_user_input_async`, as Codex's client sends them. */
export const CODEX_REPLY = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/;

/** One question Codex asked: its ID for `request_user_input`'s answers, and its options. */
interface CodexQuestion {
	id: string | null;
	question: string;
	header: string | null;
	options: string[];
}

/** The questions in a Codex question call's arguments, failing on a shape quest does not know. */
function codexQuestions(path: string, args: unknown): CodexQuestion[] {
	const parsed = typeof args === "string" ? (JSON.parse(args) as { questions?: unknown }) : null;
	if (!Array.isArray(parsed?.questions)) throw new Error(`${path} has a Codex question call without questions`);
	return parsed.questions.map((q: Record<string, unknown>) => {
		const question = q?.question ?? q?.title;
		const options = ((q?.options ?? []) as unknown[]).map((o) =>
			typeof o === "string" ? o : (o as { label?: unknown } | null)?.label,
		);
		if (typeof question !== "string" || !options.every((o): o is string => typeof o === "string"))
			throw new Error(`${path} has a Codex question in a shape quest does not know`);
		return {
			id: typeof q.id === "string" ? q.id : null,
			question,
			header: typeof q.header === "string" ? q.header : null,
			options,
		};
	});
}

/**
 * A Codex rollout's typed turns, in sessions a person runs, and its answers to Codex's blocking questions, in those
 * and the sessions T3 Code drives, since T3 Code keeps no question's options. Headless (`exec`) sessions and
 * sub-agents take only machine-written prompts.
 */
export function readCodexMessages(path: string, since: number, repositories: Repositories): Entry[] {
	const entries: Entry[] = [];
	let session: string | undefined;
	let typed = false;
	let unmarked = false;
	let where = "";
	let skill: string | null = null;
	const asked = new Map<string, CodexQuestion[] | null>();
	// `request_user_input` calls whose output holds the answers.
	const pending = new Set<string>();
	eachLine(path, (line, complete) => {
		if (session === undefined) {
			const meta = parseLine(path, line, complete);
			const payload = meta?.payload as Record<string, unknown> | undefined;
			if (meta?.type !== "session_meta" || typeof payload?.id !== "string")
				throw new Error(`${path} does not start with a Codex session_meta record`);
			if (typeof payload.source !== "string" || payload.source === "exec") return false;
			typed = payload.originator !== T3_CODEX;
			unmarked = writesNoProvenance(payload.cli_version);
			session = payload.id;
			// The directory's origin names it as other harnesses' sessions there are named when the URL Codex recorded,
			// from `git remote get-url origin`, is that origin or the URL git fetches it from after `insteadOf` rewrites;
			// a recorded repository it names neither way means the directory has since held another checkout.
			const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
			const dir = cwd === null ? null : repositories.name(cwd, payload.id);
			const url = (payload.git as Record<string, unknown> | undefined)?.repository_url;
			const recorded = typeof url === "string" ? repositories.origin(url) : null;
			const current = cwd !== null && dir !== null && !isAbsolute(dir);
			const repository =
				current && (recorded === null || repositories.names(cwd, payload.id, recorded))
					? dir
					: (recorded ?? dir);
			if (repository === null) throw new Error(`${path} names no directory`);
			where = repository;
			return true;
		}
		const output = /"call_id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
		const user = /"role"\s*:\s*"user"/.test(line);
		if (!user && !line.includes("request_user_input") && !(output !== undefined && pending.has(output))) return;
		const record = parseLine(path, line, complete);
		const item = record?.payload as Record<string, unknown> | undefined;
		if (record?.type !== "response_item" || !item) return;
		if (item.type === "function_call" && CODEX_ASK.has(item.name as string)) {
			const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
			// A question before the window is read only for an answer inside it, so a shape quest no longer
			// knows there leaves that answer unread rather than failing the window.
			let questions: CodexQuestion[] | null = null;
			try {
				questions = codexQuestions(path, item.arguments);
			} catch (error) {
				if (!(at < since)) throw error;
			}
			asked.set(item.call_id as string, questions);
			if (item.name === "request_user_input") pending.add(item.call_id as string);
			return;
		}
		const result = item.type === "function_call_output" && pending.delete(item.call_id as string);
		if (!result && item.role !== "user") return;
		const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isNaN(at)) throw new Error(`${path} has a user turn without a timestamp`);
		const base = { time: new Date(at).toISOString(), harness: "codex", repository: where, session: session! };
		/** Records the answers a turn part carries, if it is a question reply. */
		const replies = (text: string): boolean => {
			const reply = CODEX_REPLY.exec(text);
			if (!reply) return false;
			let each: Record<string, unknown>[];
			try {
				each = JSON.parse(reply[1]!);
				if (!Array.isArray(each)) throw new Error();
			} catch {
				throw new Error(`${path} has a question reply in a shape quest does not know`);
			}
			for (const one of each) {
				let ref: unknown;
				try {
					ref = JSON.parse(one?.questionItemId as string);
				} catch {}
				if (!Array.isArray(ref) || typeof one.answer !== "string")
					throw new Error(`${path} has a question reply in a shape quest does not know`);
				const questions = asked.get(ref[1] as string);
				// A question before the window in a shape quest no longer knows was left unread above.
				if (questions === null) continue;
				const q = questions?.[ref[2] as number];
				if (!q) throw new Error(`${path} has an answer to a question its log does not hold`);
				entries.push(answer({ ...base, skill }, q.question, q.header, q.options, [one.answer]));
			}
			return true;
		};
		if (result) {
			const questions = asked.get(item.call_id as string);
			if (at < since || !questions) return;
			let output: unknown;
			try {
				output = JSON.parse(item.output as string);
			} catch {
				// A cancelled or failed call returns an error message, not answers: the person gave none.
				return;
			}
			const given = (output as { answers?: unknown } | null)?.answers as Record<string, { answers?: unknown }>;
			if (typeof given !== "object" || given === null)
				throw new Error(`${path} has a Codex question's answers in a shape quest does not know`);
			for (const q of questions) {
				const picked = q.id === null ? undefined : given[q.id]?.answers;
				if (picked === undefined) continue;
				if (!Array.isArray(picked) || !picked.every((p) => typeof p === "string"))
					throw new Error(`${path} has a Codex answer in a shape quest does not know`);
				entries.push(answer({ ...base, skill }, q.question, q.header, q.options, picked));
			}
			return;
		}
		const content = Array.isArray(item.content) ? item.content : [];
		// Turns before the window, and in sessions whose typed turns T3 Code records, are read only for the skill
		// they load, so their provenance need not be one quest knows.
		if (at < since || !typed) {
			const sources = (
				(item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined)
					?.content_item_metadata as unknown[] | undefined
			)?.map((each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type);
			content.forEach((part, i) => {
				if (typeof part?.text !== "string") return;
				if (sources?.[i] === "skills") skill = codexSkill(part.text) ?? skill;
				else if (at >= since) replies(part.text);
			});
			return;
		}
		const meta = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
		const provenance = meta?.content_item_metadata;
		let sources: unknown[];
		if (Array.isArray(provenance)) {
			sources = provenance.map((each) => (each as { provenance?: { type?: unknown } } | null)?.provenance?.type);
		} else if (unmarked && meta?.content_item_kinds === undefined) {
			// Codex before 0.162 marks no part, so the parts it adds are told apart by how they open, and the rest is typed.
			sources = content.map((part) => (CODEX_WRAPPER.test(part?.text as string) ? "harness" : "user"));
		} else {
			// Codex 0.162's TUI marks each part with a kind instead. A compaction replays earlier turns, already read
			// where they were typed, with every kind unknown; a part whose kind says nothing otherwise cannot be told
			// apart.
			const kinds = meta?.content_item_kinds;
			if (!Array.isArray(kinds) || kinds.length === 0 || kinds.includes("unknown")) {
				if (Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "unknown")) return;
				throw new Error(
					`${path} has a user turn without Codex's provenance, so typed text cannot be told apart`,
				);
			}
			sources = kinds.map((kind) => {
				if (kind === "user.text") return "user";
				if (CODEX_INJECTED.has(kind as string)) return "harness";
				throw new Error(`${path} has a user turn with an unknown provenance: ${String(kind)}`);
			});
		}
		if (sources.length !== content.length)
			throw new Error(`${path} has a user turn whose provenance does not cover each part`);
		const unknown = sources.find((type) => !CODEX_SOURCES.has(type as string));
		if (unknown !== undefined || sources.includes(undefined))
			throw new Error(`${path} has a user turn with an unknown provenance: ${String(unknown)}`);
		const texts: string[] = [];
		content.forEach((part, i) => {
			if (typeof part?.text !== "string") return;
			if (sources[i] === "skills") skill = codexSkill(part.text) ?? skill;
			if (sources[i] === "user" && !replies(part.text)) texts.push(part.text);
		});
		const text = texts.join("\n").trim();
		if (typed && at >= since && text !== "") entries.push({ kind: "message", ...base, text });
	});
	return entries;
}

/** The skill a Codex `skills` turn part loads. */
export function codexSkill(text: string): string | null {
	return /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1] ?? null;
}

/** Whether a Codex version predates 0.162, the first seen to mark who wrote each part of a user turn. */
function writesNoProvenance(version: unknown): boolean {
	const [major, minor] =
		/^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version))?.slice(1, 3).map(Number) ??
		[];
	return major === 0 && minor !== undefined && minor < 162;
}

/** How the parts Codex before 0.162 adds to a user turn open: the environment, the AGENTS.md instructions, and a `!` command. */
const CODEX_WRAPPER = /^\s*(?:<environment_context>|# AGENTS\.md instructions\b|<user_shell_command>)/;

/** Who Codex says wrote a part of a user turn: the person, or the instructions, harness, or skill it added. */
const CODEX_SOURCES = new Set(["user", "agents_md", "harness", "skills"]);

/** The content kinds Codex 0.162 gives the parts of a user turn that are not text the person typed to the agent. */
const CODEX_INJECTED = new Set([
	"agents_md.instructions",
	"environments.environment_context",
	"multi_agent.role_instructions",
	"multi_agent.mode_instructions",
	"host_skills.instructions",
	"permissions.instructions",
	"collaboration_mode.instructions",
	"generic.developer_instructions",
	"tools.deferred_namespaces",
	"plugins.recommendations",
	"model.base_instructions",
	// A command the person ran with `!`, which Codex shows its agent with the output: a command, not a message.
	"shell.user_command",
]);

/** T3 Code's agent names, as the harness names `quest usage` reports. */
const T3_DRIVERS: Record<string, string> = { claudeAgent: "claude", codex: "codex" };

/**
 * The messages a person typed through T3 Code: those it records as created by the user from its web or mobile
 * client. Agents' relays, notifications, and scheduled prompts are created by an agent or carry their task, and a
 * structured question's answer comes from its server.
 */
export function readT3Messages(path: string, since: number, repositories: Repositories): Message[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT m.message_id AS id, m.created_at AS at, m.payload_json AS payload,
					pt.payload_json AS provider, p.workspace_root AS root
				FROM orchestration_v2_projection_messages m
				LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
				LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = r.provider_thread_id
				LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
				LEFT JOIN projection_projects p ON p.project_id = t.project_id
				WHERE m.role = 'user' AND m.created_at >= ?
				ORDER BY m.created_at`,
			)
			.all(new Date(since).toISOString()) as {
			id: string;
			at: string;
			payload: string;
			provider: string | null;
			root: string | null;
		}[];
		return rows.flatMap((row) => {
			const payload = JSON.parse(row.payload) as Record<string, unknown>;
			if (payload.createdBy === "agent") return [];
			if (payload.createdBy !== "user")
				throw new Error(`T3 Code message ${row.id} names an unknown sender: ${String(payload.createdBy)}`);
			if (payload.creationSource === "server" || payload.scheduledTaskId !== undefined) return [];
			if (payload.creationSource !== "web" && payload.creationSource !== "mobile")
				throw new Error(
					`T3 Code message ${row.id} comes from an unknown client: ${String(payload.creationSource)}`,
				);
			if (typeof payload.text !== "string") throw new Error(`T3 Code message ${row.id} has no text`);
			if (row.root === null) throw new Error(`T3 Code message ${row.id} belongs to no project`);
			const native = row.provider === null ? null : (JSON.parse(row.provider) as Record<string, unknown>);
			const ref = native?.nativeThreadRef as { nativeId?: unknown } | null | undefined;
			const driver = typeof native?.driver === "string" ? native.driver : null;
			const text = payload.text.trim();
			if (text === "") return [];
			return [
				{
					kind: "message" as const,
					time: new Date(row.at).toISOString(),
					harness: driver === null ? null : (T3_DRIVERS[driver] ?? driver),
					repository: repositories.name(row.root),
					session: typeof ref?.nativeId === "string" ? ref.nativeId : null,
					text,
				},
			];
		});
	} finally {
		db.close();
	}
}

/** The T3 Code project a session ran in: its root, and the worktree T3 Code made for the session, if any. */
export interface T3Project {
	root: string;
	worktree: string | null;
}

/**
 * The project each session T3 Code ever drove belongs to, by the harness's own session ID, since a person
 * can resume one outside T3 Code long after its last run there. A provider row SQLite cannot read maps nothing;
 * `readT3Messages` fails on one whose messages it reads.
 */
export function readT3Projects(path: string): Map<string, T3Project> {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT DISTINCT CASE WHEN json_valid(pt.payload_json)
						THEN json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') END AS session,
					p.workspace_root AS root,
					CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.worktreePath') END AS worktree
				FROM orchestration_v2_projection_runs r
				JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = r.provider_thread_id
				JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
				JOIN projection_projects p ON p.project_id = t.project_id`,
			)
			.all() as { session: unknown; root: string; worktree: unknown }[];
		return new Map(
			rows.flatMap((row) =>
				typeof row.session === "string"
					? [
							[
								row.session,
								{ root: row.root, worktree: typeof row.worktree === "string" ? row.worktree : null },
							],
						]
					: [],
			),
		);
	} finally {
		db.close();
	}
}

/**
 * Every message a person typed to an agent on this host since `since`, a `YYYY-MM-DD` local date, and every answer
 * they gave an agent's question, oldest first. Every repository's sessions are read, so a scoped query prints exactly
 * the entries of an unscoped one that name its repository.
 */
export function messages(query: MessagesQuery, deps: MessagesDependencies): Entry[] {
	const from = new Date(`${query.since}T00:00:00`).getTime();
	const t3 = deps.env.T3CODE_HOME || join(deps.home, ".t3");
	const state = join(t3, "userdata", "statev2.sqlite");
	if (existsSync(t3) && !existsSync(state))
		throw new Error(`T3 Code is installed at ${t3} but keeps no state at ${state}, where quest reads its messages`);
	const scope = repositories(deps.env, existsSync(t3) ? readT3Projects(state) : undefined);
	const wanted = query.repository === null ? null : folded(query.repository);
	const keep = (entry: Entry) => wanted === null || folded(entry.repository) === wanted;
	const found: Entry[] = [];
	for (const [session, path] of claudeLogs(deps)) {
		if (statSync(path).mtimeMs < from) continue;
		let skipped = 0;
		found.push(...readClaudeMessages(path, session, from, scope, () => skipped++));
		// The note names a log, never its messages, so a scoped read gives it as an unscoped one does.
		if (skipped)
			deps.warn?.(`skipped ${skipped} malformed line${skipped === 1 ? "" : "s"} in session ${session} (${path})`);
	}
	const codex = deps.env.CODEX_HOME || join(deps.home, ".codex");
	const threads = new Set<string>();
	for (const path of [
		...logsSince(join(codex, "sessions"), from),
		...logsSince(join(codex, "archived_sessions"), from),
	]) {
		// An archived rollout can still sit in the sessions tree too; its file name ends with its thread ID.
		const thread = /([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] ?? path;
		if (threads.has(thread)) continue;
		threads.add(thread);
		found.push(...readCodexMessages(path, from, scope));
	}
	if (existsSync(t3)) found.push(...readT3Messages(state, from, scope));
	// The others are counted, never named; a directory no origin names can hold this repository's sessions.
	const others = new Set(found.filter((entry) => !keep(entry)).map((entry) => folded(entry.repository)));
	if (others.size) {
		const unnamed = [...others].filter((name) => isAbsolute(name)).length;
		deps.warn?.(
			`printed ${query.repository}'s entries only, leaving out ${others.size} other ${others.size === 1 ? "repository's" : "repositories'"}, ${unnamed} of them ${unnamed === 1 ? "a directory" : "directories"} no GitHub or Kixel Quest origin names`,
		);
	}
	return found.filter(keep).sort((a, b) => a.time.localeCompare(b.time));
}

/** The entries as plain lines: a header per entry, then its text, or an answer's question and picks, indented. */
export function messageLines(found: Entry[]): string[] {
	return found.flatMap((m) => {
		const head = `${m.time} ${m.harness ?? "-"} ${m.repository} ${m.session ?? "-"}`;
		const indent = (text: string) => text.split("\n").map((line) => `  ${line}`.trimEnd());
		if (m.kind === "message") return [head, ...indent(m.text)];
		return [
			`${head} answer ${m.skill ?? "-"}`,
			...indent(m.header === null ? m.question : `[${m.header}] ${m.question}`),
			`  recommended: ${m.recommended.join(" | ") || "-"}`,
			`  picked: ${m.picked.join(" | ")}`,
		];
	});
}
