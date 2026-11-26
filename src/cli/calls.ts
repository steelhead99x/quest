// The shell calls an agent session runs, sampled by Quest's tool hooks around each one: the CPU counter of the
// session's cgroup, where that cgroup holds the session alone. A session's record groups the calls that overlapped
// and charges each group what the cgroup used meanwhile, which `quest gate`'s own scopes, outside it, never add to.
import { readFileSync } from "node:fs";
import { join } from "node:path/posix";

import { type Runs, type ShellCall, type ShellGroup, commandName } from "../core";
import { cgroupUsage, members } from "./supervise";
import { appendLog, logDays, logDirectory, readDays } from "./waits";

/** The session's cgroup and its CPU counter, in microseconds, when a hook sampled them. */
export interface Sample {
	at: string;
	/** The cgroup's path, or null when it held more than the session, or on a host without one. */
	cgroup: string | null;
	usage: number | null;
}

/** Whose call a line is about: a Claude Code sub-agent's carries its agent ID beside its parent's session ID. */
interface Caller {
	harness: string;
	session: string;
	agent: string | null;
}

/**
 * One line of the call log: a shell call starting, one returning, with the background task a harness moved it to,
 * or a Claude Code turn ending, with the background tasks still running then.
 */
export type CallLine = Sample &
	(
		| (Caller & { kind: "start"; call: string; command: string })
		| (Caller & { kind: "end"; call: string; task: string | null })
		| { kind: "stop"; harness: string; session: string; running: string[] }
	);

/** Where the call samples are logged. */
export const callsDirectory = (env: NodeJS.ProcessEnv = process.env) => logDirectory("calls", env);

/** Append `line` to today's call log. Throws when it cannot write. */
export function logCall(line: CallLine, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
	appendLog(callsDirectory(env), line, now, "shell call");
}

/**
 * A start line for `command`, as a record keeps it: the programs it runs, without arguments, each one `runs` says
 * the host can run.
 */
export function startLine(caller: Caller, call: string, command: string, runs: Runs, sample: Sample): CallLine {
	return { kind: "start", ...caller, call, command: commandName(command, runs), ...sample };
}

/**
 * The call lines logged on this host from the UTC day before `since`'s on, and from each earlier day while one of
 * them is about a call whose start or background handoff lies earlier, so a group that began before the window ends
 * where it did. Skips a line it cannot read.
 */
export function readCalls(since: number, env: NodeJS.ProcessEnv = process.env): CallLine[] {
	const dir = callsDirectory(env);
	const days = logDays(dir);
	// The day before the window's, too: a background call handed off then and finished before the window's first turn
	// end leaves no line in the window naming it, yet ends the group a call in the window overlapped. Only one turn
	// running over a day hides such a call still.
	const first = new Date(since - 86_400_000).toISOString().slice(0, 10);
	let from = days.findIndex((name) => name >= first);
	if (from === -1) from = days.length;
	let lines = readDays(dir, days.slice(from), parseCall, "a shell call");
	while (from > 0 && begunEarlier(lines)) {
		from--;
		lines = [...readDays(dir, [days[from]!], parseCall, "a shell call"), ...lines];
	}
	return lines;
}

/** Whether `lines` hold a call's return without its start, or a running background task without its handoff. */
function begunEarlier(lines: CallLine[]): boolean {
	const started = new Set<string>();
	const handed = new Set<string>();
	for (const line of lines) {
		if (line.kind === "start") started.add(`${line.harness}\0${line.session}\0${line.call}`);
		if (line.kind === "end" && line.task !== null) handed.add(`${line.harness}\0${line.session}\0${line.task}`);
	}
	return lines.some((line) =>
		line.kind === "end"
			? !started.has(`${line.harness}\0${line.session}\0${line.call}`)
			: line.kind === "stop" &&
				line.running.some((task) => !handed.has(`${line.harness}\0${line.session}\0${task}`)),
	);
}

function parseCall(line: string): CallLine | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const text = (v: unknown) => typeof v === "string" && v !== "";
	const sampled =
		typeof value?.at === "string" &&
		!Number.isNaN(Date.parse(value.at)) &&
		(value.cgroup === null || text(value.cgroup)) &&
		(value.usage === null || (typeof value.usage === "number" && value.usage >= 0)) &&
		text(value.harness) &&
		text(value.session);
	if (!sampled) return null;
	const caller = (value.agent === null || text(value.agent)) && text(value.call);
	switch (value.kind) {
		case "start":
			return caller && typeof value.command === "string" ? (value as unknown as CallLine) : null;
		case "end":
			return caller && (value.task === null || text(value.task)) ? (value as unknown as CallLine) : null;
		case "stop":
			return Array.isArray(value.running) && value.running.every(text) ? (value as unknown as CallLine) : null;
		default:
			return null;
	}
}

/** Where `sessionSample` reads processes and cgroups, and which process the hook and its harness are. */
export interface Host {
	proc: string;
	cgroups: string;
	self: number;
	/**
	 * The harness's process, where it names it, as Claude Code does in `CLAUDE_PID`, else the name it runs under, as
	 * Codex's `codex`.
	 */
	harness: { pid: number } | { name: string };
	/** The hook's session ID, which the harness gives each command it runs in its environment. */
	session: string;
}

/**
 * The cgroup holding this process and its CPU counter now, or nulls where it holds more than the hook's session.
 * Such a cgroup holds one tree of processes, whose top is the harness: the hook's topmost ancestor in the cgroup, from
 * which every other branch hangs, as when an app starts each agent session in a scope of its own. A terminal's scope
 * fails, since its top is the terminal's shell, as does one shared with other work. A process whose parent left, as
 * a daemonized one's does, is the session's leftover and counts where init or a systemd manager adopted it and its
 * environment names the session, as the harness gives each command; any other is other work.
 */
export function sessionSample(now: number, host: Host): Sample {
	const at = new Date(now).toISOString();
	const none = { at, cgroup: null, usage: null };
	if (process.platform !== "linux") return none;
	const path = readFileSync(join(host.proc, String(host.self), "cgroup"), "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	if (path === undefined) return none;
	const group = join(host.cgroups, path);
	const inside = new Set(members(group));
	const parents = new Map<number, number | undefined>();
	const parent = (pid: number) => {
		if (!parents.has(pid)) parents.set(pid, parentOf(host.proc, pid));
		return parents.get(pid);
	};
	const chain = new Set<number>();
	let top = host.self;
	for (let pid: number | undefined = host.self; pid !== undefined && inside.has(pid); pid = parent(pid)) {
		chain.add(pid);
		top = pid;
	}
	if (!chain.has(host.self) || !harnessIs(host, top)) return none;
	for (const pid of inside) {
		if (chain.has(pid)) continue;
		// The chain member this process hangs from, else its tree's root's parent outside the cgroup, or undefined.
		let at: number | undefined = parent(pid);
		while (at !== undefined && inside.has(at) && !chain.has(at)) at = parent(at);
		if (at !== undefined && chain.has(at) && at !== top) return none;
		// A tree outside the harness's counts only as a daemon the session left: init or the user's service manager,
		// as the reaper of orphans, adopted its root, whose environment names the session. A live parent elsewhere, or
		// an orphan of another session's, means other work shares the cgroup.
		if (at !== undefined && !chain.has(at)) {
			let root = pid;
			while (parent(root) !== at) root = parent(root)!;
			if (!adopted(host.proc, at) || !ownedBy(host.proc, root, host.session)) return none;
		}
	}
	const usage = cgroupUsage(group);
	return usage === null ? none : { at, cgroup: path, usage };
}

/** Whether `pid` reaps orphans: init, or a systemd service manager, such as the user's. */
function adopted(proc: string, pid: number): boolean {
	if (pid === 1) return true;
	try {
		return readFileSync(join(proc, String(pid), "comm"), "utf8").trim() === "systemd";
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

/** Whether `pid`'s environment names `session` as Claude Code's or Codex's, as each gives the commands it runs. */
function ownedBy(proc: string, pid: number, session: string): boolean {
	if (session === "") return false;
	let environ: string;
	try {
		environ = readFileSync(join(proc, String(pid), "environ"), "utf8");
	} catch (error) {
		if (["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
	const names = environ.split("\0");
	return names.includes(`CLAUDE_CODE_SESSION_ID=${session}`) || names.includes(`CODEX_THREAD_ID=${session}`);
}

/** Whether `pid` is the harness `host` names, by its process ID or its name. */
function harnessIs(host: Host, pid: number): boolean {
	if ("pid" in host.harness) return host.harness.pid === pid;
	try {
		return readFileSync(join(host.proc, String(pid), "comm"), "utf8").trim() === host.harness.name;
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

/** Field 4 of /proc/<pid>/stat, or undefined once the process is gone. */
function parentOf(proc: string, pid: number): number | undefined {
	let stat: string;
	try {
		stat = readFileSync(join(proc, String(pid), "stat"), "utf8");
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
	return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

/** Calls that overlapped in one cgroup, each with its session, and what the cgroup used meanwhile. */
export interface OwnedGroup {
	/** Each call, oldest first, with its session as `harness\0session`, a Claude sub-agent's being its agent ID. */
	calls: { session: string; call: ShellCall }[];
	cpu: number | null;
	/** Its first call's start, epoch ms. */
	start: number;
}

/** `group` as `session`'s record holds it: only its own calls, and whether others ran in it too. */
export function sessionGroup(group: OwnedGroup, session: string): ShellGroup | null {
	const own = group.calls.filter((c) => c.session === session).map((c) => c.call);
	return own.length ? { calls: own, cpu: group.cpu, shared: own.length < group.calls.length } : null;
}

type Start = Extract<CallLine, { kind: "start" }>;

/**
 * The calls in `lines`, grouped where they overlapped in one cgroup, each group charged what its cgroup used from its
 * first call's start to its last call's end. A call that never returned, as one denied or interrupted, is left out. A
 * call a Claude Code session moved to the background runs until the first turn end that no longer lists its task,
 * else until its cgroup's last sample. A call sampled outside a counted cgroup is a group of its own, without CPU.
 */
export function shellGroups(lines: CallLine[]): OwnedGroup[] {
	const callKey = (l: { harness: string; session: string; call: string }) => `${l.harness}\0${l.session}\0${l.call}`;
	const ends = new Map<string, Extract<CallLine, { kind: "end" }>>();
	const stops = new Map<string, Extract<CallLine, { kind: "stop" }>[]>();
	const last = new Map<string, Sample>();
	const ms = (s: Sample) => Date.parse(s.at);
	for (const line of lines) {
		if (line.kind === "end") ends.set(callKey(line), line);
		if (line.kind === "stop") {
			const key = `${line.harness}\0${line.session}`;
			stops.set(key, [...(stops.get(key) ?? []), line]);
		}
		if (line.cgroup !== null && ms(line) >= ms(last.get(line.cgroup) ?? line)) last.set(line.cgroup, line);
	}
	const calls: { start: Start; end: Sample }[] = [];
	for (const start of lines) {
		if (start.kind !== "start") continue;
		const returned = ends.get(callKey(start));
		if (!returned || ms(returned) < ms(start)) continue;
		let end: Sample = returned;
		if (returned.task !== null) {
			const finished = (stops.get(`${start.harness}\0${start.session}`) ?? [])
				.filter((stop) => ms(stop) >= ms(returned) && !stop.running.includes(returned.task!))
				.sort((a, b) => ms(a) - ms(b))[0];
			end = finished ?? (start.cgroup === null ? returned : (last.get(start.cgroup) ?? returned));
		}
		calls.push({ start, end });
	}
	calls.sort((a, b) => ms(a.start) - ms(b.start));
	const groups: { calls: typeof calls; end: Sample }[] = [];
	const open = new Map<string, (typeof groups)[number]>();
	for (const call of calls) {
		const current = call.start.cgroup === null ? undefined : open.get(call.start.cgroup);
		if (current && ms(call.start) <= ms(current.end)) {
			current.calls.push(call);
			if (ms(call.end) > ms(current.end)) current.end = call.end;
			continue;
		}
		const group = { calls: [call], end: call.end };
		groups.push(group);
		if (call.start.cgroup !== null) open.set(call.start.cgroup, group);
	}
	return groups.map(({ calls: grouped, end }) => {
		const first = grouped[0]!.start;
		const counted =
			first.cgroup !== null &&
			end.cgroup === first.cgroup &&
			first.usage !== null &&
			end.usage !== null &&
			end.usage >= first.usage;
		return {
			calls: grouped.map((c) => ({
				session: `${c.start.harness}\0${c.start.agent ?? c.start.session}`,
				call: { command: c.start.command, start: c.start.at, end: c.end.at },
			})),
			cpu: counted ? Math.round((end.usage! - first.usage!) / 1000) : null,
			start: ms(first),
		};
	});
}
