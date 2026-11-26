import { type BreakageRecord, breakageKey, parseBreakage } from "./breakage";
import { isCommandName } from "./command";
import { parser } from "./parse";

// The record of one agent session that `quest` sends to Kixel Code, which stores exactly this shape, and that
// `quest usage` prints. One session is one record: a resend under the same harness and session ID replaces it. A
// host's one sender uploads a session's copies in order, so the latest upload is the newest copy.

/** What a session did for its PRs. */
export const ROLES = [
	"planning",
	"implementing",
	"iterating",
	"reviewing",
	"classifying",
	"merging",
	"coordinating",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * What a session waited on, timed by the tool that waited: queued in `quest gate`, running a gated command, waiting
 * in `quest wait` for PR activity, which `until` names, or for the merge queue to merge or drop the PR, and waiting
 * on a person's answer to a blocking question.
 */
export const WAIT_KINDS = ["gate-queue", "gate-run", "pull", "merge-queue", "person"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** One timed wait, its instants ISO 8601 UTC. */
export interface SessionWait {
	kind: WaitKind;
	start: string;
	end: string;
	/** For a `pull` or `merge-queue` wait, the first activity `quest wait` printed, as `checks:passed`; null on timeout. */
	until: string | null;
}

/** One outermost `quest gate` run, its instants ISO 8601 UTC. */
export interface GatedRun {
	/** The programs it ran, as `commandName` keeps them: no arguments. */
	command: string;
	/** When it asked to be admitted. */
	start: string;
	/** When it was admitted; null for a run that ended while queued. */
	admitted: string | null;
	end: string;
	/** The CPU milliseconds its command used; null where the gate ran it outside a systemd scope. */
	cpu: number | null;
}

/** One shell call a session's harness ran, its instants ISO 8601 UTC. */
export interface ShellCall {
	/** The programs it ran, as `commandName` keeps them: no arguments. */
	command: string;
	start: string;
	/** When it returned, or for one the harness ran in the background, when it was first seen finished. */
	end: string;
}

/**
 * Shell calls that overlapped in one cgroup, and the CPU milliseconds it used from the first one's start to the
 * last one's end: what ran outside `quest gate`, and the harness itself meanwhile. A group shared by sessions in
 * one cgroup, as a sub-agent's with its parent's, is in each of their records, listing only that session's calls.
 */
export interface ShellGroup {
	/** The session's calls in it, oldest first. */
	calls: ShellCall[];
	/** Null where the cgroup held more than the session, as a terminal's may, or none counts it, as on macOS. */
	cpu: number | null;
	/** Whether calls of other sessions in its cgroup ran in it too, sharing its CPU. */
	shared: boolean;
}

/** One model and effort's tokens in a session, and their cost at API list price in USD. */
export interface ModelSpend {
	model: string | null;
	effort: string | null;
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
	cost: number;
	/** False when the cost is a lower bound: a request went unpriced or a transcript line was unreadable. */
	complete: boolean;
}

/**
 * Where a session's working time went, beyond its timed waits. The list is fixed so splits compare across weeks;
 * change it only with a dated note here, since a change breaks the trend. `idle` is not classified: it is the time
 * between turns, until the next message from a person or a notification. Settled 2026-11-13 from a sample of this
 * host's Claude Code and Codex transcripts.
 */
export const SPLIT_CATEGORIES = [
	"understanding",
	"researching",
	"writing",
	"testing",
	"environment",
	"git",
	"forge",
	"reviewing",
	"rework",
	"coordinating",
	"operating",
	"reporting",
	"circles",
	"waiting",
	"other",
	"idle",
] as const;
export type SplitCategory = (typeof SPLIT_CATEGORIES)[number];

/** One model's tokens in the turns that classified a session, as the CLI reported them. */
export interface SplitUsage {
	harness: string;
	model: string;
	effort: string;
	input: number;
	/** The part of `input` read from the prompt cache. */
	cached: number;
	output: number;
}

/**
 * A session's time and tokens by category, as a cheap model sorted its steps. Its categories' time and its timed
 * waits, without overlap, sum to its transcript's span; their tokens sum to its transcript's.
 */
export interface TimeSplit {
	/** Every category, with its milliseconds and tokens. */
	categories: Record<SplitCategory, { ms: number; tokens: number }>;
	/** One line per classified part where something went wrong, naming no one and quoting no message. */
	notes: string[];
	/**
	 * The time a stronger model sorted again, and the part of it the two sorted differently, or null when no part
	 * was sampled.
	 */
	check: { ms: number; disagreed: number } | null;
	/** What classifying it took, by model. */
	usage: SplitUsage[];
}

/** One agent session, as `quest` sends it. */
export interface SessionRecord {
	/** `claude` or `codex`. */
	harness: string;
	/**
	 * The harness's own session ID; a Claude sub-agent's is its agent ID. Null when its transcript names none, which
	 * `quest usage` still reports but no upload carries, since the store replaces a record by its ID.
	 */
	session: string | null;
	/** The session that spawned it, or null. */
	parent: string | null;
	/** The base repository as lowercase `owner/repo`. */
	repository: string;
	/** Its PR's head branch, else the branch it last named, so a session before its PR opens joins it later. */
	branch: string | null;
	/** The quest file its branch claims, as `quest/m0/foo.md`. */
	quest: string | null;
	/**
	 * The PRs it worked on: its own, else its parent's, else, for a coordinator, every PR its sub-agents worked on.
	 * Its cost counts equally toward each, so a PR's cost is the sum of each record's cost over its PR count.
	 */
	pulls: number[];
	role: Role;
	models: ModelSpend[];
	cost: number;
	complete: boolean;
	/** Its first and last request, ISO 8601 UTC. */
	start: string;
	end: string;
	/** Its timed waits, oldest first; null when they could not be read, as for a session on another host. */
	waits: SessionWait[] | null;
	/** Its outermost `quest gate` runs, oldest first; null for a session on another host. */
	gated: GatedRun[] | null;
	/**
	 * Its shell calls, grouped where they overlapped, from the groups that started since the window's start, oldest
	 * first; null for a session on another host.
	 */
	shell: ShellGroup[] | null;
	/** Where the rest of its time went; null until every step is classified, and for a session on another host. */
	split: TimeSplit | null;
}

/** The body of a record upload: sessions' records, and the breakages the uploading host knows of. */
export interface RecordUpload {
	records: SessionRecord[];
	breakages: BreakageRecord[];
}

const {
	fail,
	isObject,
	text,
	maybe,
	count,
	flag,
	instant,
	oneOf,
	exact,
	pull,
	repository: ownerRepo,
} = parser("session record");

/** `value` as a record, failing on any missing, extra, or ill-typed field, so a store never keeps one in part. */
export function parseRecord(value: unknown): SessionRecord {
	if (!isObject(value)) return fail("not an object");
	const keys = [
		"harness",
		"session",
		"parent",
		"repository",
		"branch",
		"quest",
		"pulls",
		"role",
		"models",
		"cost",
		"complete",
		"start",
		"end",
		"waits",
		"gated",
		"shell",
		"split",
	];
	exact(value, keys, "the record");
	const pulls = Array.isArray(value.pulls) ? value.pulls : fail("pulls");
	const models = Array.isArray(value.models) ? value.models : fail("models");
	const waits = value.waits === null ? null : Array.isArray(value.waits) ? value.waits : fail("waits");
	const gated = value.gated === null ? null : Array.isArray(value.gated) ? value.gated : fail("gated");
	const shell = value.shell === null ? null : Array.isArray(value.shell) ? value.shell : fail("shell");
	const repository = ownerRepo(value.repository, "repository");
	const quest = maybe(value.quest, "quest");
	if (quest !== null && !/^quest\/.+\.md$/.test(quest)) fail("quest is not a quest path");
	const record: SessionRecord = {
		harness: text(value.harness, "harness"),
		session: maybe(value.session, "session"),
		parent: maybe(value.parent, "parent"),
		repository,
		branch: maybe(value.branch, "branch"),
		quest,
		pulls: pulls.map((n) => pull(n, "a PR number")),
		role: oneOf(value.role, ROLES, "role"),
		models: models.map((m: unknown) => {
			if (!isObject(m)) return fail("a model");
			exact(m, ["model", "effort", "input", "cacheWrite", "cacheRead", "output", "cost", "complete"], "a model");
			return {
				model: maybe(m.model, "a model name"),
				effort: maybe(m.effort, "an effort"),
				input: count(m.input, "input tokens"),
				cacheWrite: count(m.cacheWrite, "cache write tokens"),
				cacheRead: count(m.cacheRead, "cache read tokens"),
				output: count(m.output, "output tokens"),
				cost: count(m.cost, "a model's cost"),
				complete: flag(m.complete, "a model's completeness"),
			};
		}),
		cost: count(value.cost, "cost"),
		complete: flag(value.complete, "completeness"),
		start: instant(value.start, "start"),
		end: instant(value.end, "end"),
		waits:
			waits?.map((w: unknown) => {
				if (!isObject(w)) return fail("a wait");
				exact(w, ["kind", "start", "end", "until"], "a wait");
				const wait: SessionWait = {
					kind: oneOf(w.kind, WAIT_KINDS, "a wait's kind"),
					start: instant(w.start, "a wait's start"),
					end: instant(w.end, "a wait's end"),
					until: maybe(w.until, "a wait's until"),
				};
				if (Date.parse(wait.end) < Date.parse(wait.start)) fail("a wait ends before it starts");
				if (wait.until !== null && wait.kind !== "pull" && wait.kind !== "merge-queue")
					fail(`a ${wait.kind} wait names what ended it`);
				return wait;
			}) ?? null,
		gated: gated?.map(parseGated) ?? null,
		shell: shell?.map(parseGroup) ?? null,
		split: value.split === null ? null : parseSplit(value.split),
	};
	if (new Set(record.pulls).size !== record.pulls.length) fail("a PR listed twice");
	if (record.split !== null && record.waits === null) fail("a split without the waits it leaves out");
	if (Date.parse(record.end) < Date.parse(record.start)) fail("it ends before it starts");
	return record;
}

/** Program names as `commandName` keeps them, so no record carries a command's arguments. */
function command(value: unknown, field: string): string {
	const name = text(value, field);
	return isCommandName(name) ? name : fail(`${field} is not program names alone`);
}

/** CPU milliseconds, or null. */
const cpu = (value: unknown, field: string): number | null => (value === null ? null : count(value, field));

/** A gated run, failing on an admission outside its run. */
function parseGated(value: unknown): GatedRun {
	if (!isObject(value)) return fail("a gated run");
	exact(value, ["command", "start", "admitted", "end", "cpu"], "a gated run");
	const run: GatedRun = {
		command: command(value.command, "a gated command"),
		start: instant(value.start, "a gated run's start"),
		admitted: value.admitted === null ? null : instant(value.admitted, "a gated run's admission"),
		end: instant(value.end, "a gated run's end"),
		cpu: cpu(value.cpu, "a gated run's CPU"),
	};
	const [start, end] = [Date.parse(run.start), Date.parse(run.end)];
	const admitted = run.admitted === null ? start : Date.parse(run.admitted);
	if (admitted < start || end < admitted) fail("a gated run's instants are out of order");
	if (run.admitted === null && run.cpu !== null) fail("a gated run that never started used CPU");
	return run;
}

/** A shell group, failing on one without calls or a call that ends before it starts. */
function parseGroup(value: unknown): ShellGroup {
	if (!isObject(value)) return fail("a shell group");
	exact(value, ["calls", "cpu", "shared"], "a shell group");
	if (!Array.isArray(value.calls) || value.calls.length === 0) return fail("a shell group's calls");
	return {
		calls: value.calls.map((c: unknown) => {
			if (!isObject(c)) return fail("a shell call");
			exact(c, ["command", "start", "end"], "a shell call");
			const call: ShellCall = {
				command: command(c.command, "a shell command"),
				start: instant(c.start, "a shell call's start"),
				end: instant(c.end, "a shell call's end"),
			};
			if (Date.parse(call.end) < Date.parse(call.start)) fail("a shell call ends before it starts");
			return call;
		}),
		cpu: cpu(value.cpu, "a shell group's CPU"),
		shared: flag(value.shared, "whether a shell group is shared"),
	};
}

/** A split, failing on a missing or unknown category, a disagreement past what was checked, or a multi-line note. */
function parseSplit(value: unknown): TimeSplit {
	if (!isObject(value)) return fail("the split");
	exact(value, ["categories", "notes", "check", "usage"], "the split");
	const categories = isObject(value.categories) ? value.categories : fail("the split's categories");
	exact(categories, [...SPLIT_CATEGORIES], "the split's categories");
	const notes = Array.isArray(value.notes) ? value.notes : fail("the split's notes");
	const usage = Array.isArray(value.usage) ? value.usage : fail("the split's usage");
	let check: TimeSplit["check"] = null;
	if (value.check !== null) {
		if (!isObject(value.check)) return fail("the split's check");
		exact(value.check, ["ms", "disagreed"], "the split's check");
		check = {
			ms: count(value.check.ms, "the checked time"),
			disagreed: count(value.check.disagreed, "the disagreed time"),
		};
		if (check.disagreed > check.ms) fail("the check disagrees on more time than it checked");
	}
	return {
		categories: Object.fromEntries(
			SPLIT_CATEGORIES.map((name) => {
				const each = categories[name];
				if (!isObject(each)) return fail(`the split's ${name}`);
				exact(each, ["ms", "tokens"], `the split's ${name}`);
				return [name, { ms: count(each.ms, `${name}'s time`), tokens: count(each.tokens, `${name}'s tokens`) }];
			}),
		) as TimeSplit["categories"],
		notes: notes.map((note) => {
			const line = text(note, "a split note");
			return /[\r\n]/.test(line) || line.length > NOTE_LIMIT ? fail("a split note is not one short line") : line;
		}),
		check,
		usage: usage.map((u: unknown) => {
			if (!isObject(u)) return fail("a split's usage");
			exact(u, ["harness", "model", "effort", "input", "cached", "output"], "a split's usage");
			const input = count(u.input, "a split's input tokens");
			const cached = count(u.cached, "a split's cached tokens");
			if (cached > input) fail("a split's cached tokens exceed its input");
			return {
				harness: text(u.harness, "a split's harness"),
				model: text(u.model, "a split's model"),
				effort: text(u.effort, "a split's effort"),
				input,
				cached,
				output: count(u.output, "a split's output tokens"),
			};
		}),
	};
}

/** The longest note a split keeps, in characters. */
export const NOTE_LIMIT = 300;

/**
 * An upload's body, failing whole on any malformed record, one naming no session, or a session or breakage sent
 * twice.
 */
export function parseUpload(value: unknown): RecordUpload {
	if (!isObject(value)) return fail("the upload is not an object");
	exact(value, ["records", "breakages"], "the upload");
	if (!Array.isArray(value.records)) return fail("the upload has no record list");
	if (!Array.isArray(value.breakages)) return fail("the upload has no breakage list");
	const breakages = value.breakages.map(parseBreakage);
	if (new Set(breakages.map(breakageKey)).size !== breakages.length) fail("the upload holds a breakage twice");
	const records = value.records.map(parseRecord);
	if (records.some((r) => r.session === null)) fail("an uploaded record names no session");
	const ids = new Set(records.map((r) => `${r.harness}\0${r.session}`));
	if (ids.size !== records.length) fail("the upload holds a session twice");
	return { records, breakages };
}
