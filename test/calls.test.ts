import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
	type CallLine,
	type Sample,
	logCall,
	readCalls,
	sessionGroup,
	sessionSample,
	shellGroups,
} from "../src/cli/calls";
import { tempDir } from "./fixture";

describe.skipIf(process.platform !== "linux")("sessionSample", () => {
	const scope = "/app.slice/agent.scope";
	/** A fake /proc and cgroup tree: each process's parent, which are in the session's scope, and the name of 10. */
	function host(
		parents: Record<number, number>,
		scoped: number[],
		self: number,
		sessions: Record<number, string> = {},
	) {
		const proc = tempDir();
		const cgroups = tempDir();
		for (const [pid, parent] of Object.entries(parents)) {
			mkdirSync(join(proc, pid));
			// The command name may hold spaces and parentheses.
			writeFileSync(join(proc, pid, "stat"), `${pid} (a (b) c) S ${parent} 1 1 0\n`);
			writeFileSync(join(proc, pid, "comm"), pid === "10" ? "codex\n" : "bash\n");
			const session = sessions[Number(pid)];
			writeFileSync(
				join(proc, pid, "environ"),
				session ? `PATH=/bin\0CLAUDE_CODE_SESSION_ID=${session}\0` : "PATH=/bin\0",
			);
			writeFileSync(join(proc, pid, "cgroup"), `0::${scoped.includes(Number(pid)) ? scope : "/other.scope"}\n`);
		}
		mkdirSync(join(cgroups, scope), { recursive: true });
		writeFileSync(join(cgroups, scope, "cgroup.procs"), `${scoped.join("\n")}\n`);
		writeFileSync(join(cgroups, scope, "cpu.stat"), "usage_usec 7000\nuser_usec 5000\n");
		return { proc, cgroups, self, session: "s" };
	}
	const at = Date.parse("2026-11-15T10:00:00Z");
	const counted: Sample = { at: "2026-11-15T10:00:00.000Z", cgroup: scope, usage: 7000 };
	const none: Sample = { ...counted, cgroup: null, usage: null };

	test("counts a scope whose top is the harness, every other branch hanging from it", () => {
		// The harness 10, its hook shell 20 and hook 30, an MCP server 11, a tool shell 12 and its child 13, and a
		// daemon 40 whose parent left.
		const parents = { 10: 1, 20: 10, 30: 20, 11: 10, 12: 10, 13: 12, 40: 1 };
		const each = host(parents, [10, 20, 30, 11, 12, 13, 40], 30, { 40: "s" });
		expect(sessionSample(at, { ...each, harness: { pid: 10 } })).toEqual(counted);
		expect(sessionSample(at, { ...each, harness: { name: "codex" } })).toEqual(counted);
		// A harness that names itself, or runs under a name, elsewhere is not this scope's top.
		expect(sessionSample(at, { ...each, harness: { pid: 20 } })).toEqual(none);
		expect(sessionSample(at, { ...each, harness: { name: "claude" } })).toEqual(none);
	});

	test("refuses a terminal's scope, whose top is the terminal's shell", () => {
		// The shell 5 runs the harness 10 and a background job 6, which hangs from the top as the harness's would.
		const parents = { 5: 1, 10: 5, 20: 10, 30: 20, 6: 5 };
		const each = host(parents, [5, 10, 20, 30, 6], 30);
		expect(sessionSample(at, { ...each, harness: { name: "codex" } })).toEqual(none);
		expect(sessionSample(at, { ...each, harness: { pid: 10 } })).toEqual(none);
		// A branch below the hook's chain but not from its top shares the cgroup too.
		const below = { 10: 1, 20: 10, 30: 20, 21: 20 };
		expect(sessionSample(at, { ...host(below, [10, 20, 30, 21], 30), harness: { pid: 10 } })).toEqual(none);
	});

	test("refuses a scope shared with another tree whose parent still runs elsewhere", () => {
		// The app 2 starts the harness 10 and, in the same scope, an unrelated process 50.
		const parents = { 2: 1, 10: 2, 20: 10, 30: 20, 50: 2 };
		const each = host(parents, [10, 20, 30, 50], 30);
		expect(sessionSample(at, { ...each, harness: { pid: 10 } })).toEqual(none);
	});

	test("refuses an orphan whose environment names another session, or none", () => {
		// Init adopted 50, as it would another harness whose launcher exited, or a daemon of another session's.
		const parents = { 10: 1, 20: 10, 30: 20, 50: 1, 51: 50 };
		for (const sessions of [{}, { 50: "other" }] as Record<number, string>[]) {
			const each = host(parents, [10, 20, 30, 50, 51], 30, sessions);
			expect(sessionSample(at, { ...each, harness: { pid: 10 } })).toEqual(none);
		}
		// Its own daemon, with a child of its own, counts.
		const own = host(parents, [10, 20, 30, 50, 51], 30, { 50: "s" });
		expect(sessionSample(at, { ...own, harness: { pid: 10 } })).toEqual(counted);
	});

	test("refuses a hook outside the cgroup it reads", () => {
		const each = host({ 10: 1, 30: 10 }, [10], 30);
		expect(sessionSample(at, { ...each, harness: { pid: 10 } })).toEqual(none);
	});
});

describe("shellGroups", () => {
	const t = (s: number) => new Date(Date.parse("2026-11-15T10:00:00Z") + s * 1000).toISOString();
	const cg = "/agent.scope";
	const start = (call: string, s: number, usage: number | null, extra: Partial<CallLine> = {}): CallLine =>
		({
			kind: "start",
			harness: "claude",
			session: "s",
			agent: null,
			call,
			command: `run ${call}`,
			at: t(s),
			cgroup: cg,
			usage,
			...extra,
		}) as CallLine;
	const end = (call: string, s: number, usage: number | null, extra: Partial<CallLine> = {}): CallLine =>
		({
			kind: "end",
			harness: "claude",
			session: "s",
			agent: null,
			call,
			task: null,
			at: t(s),
			cgroup: cg,
			usage,
			...extra,
		}) as CallLine;
	const stop = (s: number, running: string[], usage: number): CallLine => ({
		kind: "stop",
		harness: "claude",
		session: "s",
		running,
		at: t(s),
		cgroup: cg,
		usage,
	});

	test("charges overlapping calls together, and each lone call its own span", () => {
		const groups = shellGroups([
			start("a", 0, 1_000_000),
			start("b", 1, 1_100_000, { agent: "sub" } as Partial<CallLine>),
			end("a", 2, 1_500_000),
			end("b", 3, 2_000_000, { agent: "sub" } as Partial<CallLine>),
			start("c", 10, 3_000_000),
			end("c", 11, 3_250_400),
			// Denied or interrupted: it never returned.
			start("d", 12, 3_300_000),
		]);
		expect(groups.map((g) => [g.calls.map((c) => [c.session, c.call]), g.cpu, g.start])).toEqual([
			[
				[
					["claude\0s", { command: "run a", start: t(0), end: t(2) }],
					["claude\0sub", { command: "run b", start: t(1), end: t(3) }],
				],
				1000,
				Date.parse(t(0)),
			],
			[[["claude\0s", { command: "run c", start: t(10), end: t(11) }]], 250, Date.parse(t(10))],
		]);
		// Each session's record holds its own calls, and says another's shared the group's CPU.
		expect(sessionGroup(groups[0]!, "claude\0sub")).toEqual({
			calls: [{ command: "run b", start: t(1), end: t(3) }],
			cpu: 1000,
			shared: true,
		});
		expect(sessionGroup(groups[1]!, "claude\0s")).toMatchObject({ shared: false });
		expect(sessionGroup(groups[1]!, "claude\0sub")).toBeNull();
	});

	test("a background call runs until a turn end no longer lists its task", () => {
		const lines = [
			start("bg", 0, 0),
			end("bg", 1, 10_000, { task: "b1" } as Partial<CallLine>),
			stop(5, ["b1"], 50_000),
			start("fg", 6, 60_000),
			end("fg", 7, 70_000),
			stop(9, [], 90_000),
		];
		expect(shellGroups(lines).map((g) => [g.calls.map((c) => c.call.end), g.cpu])).toEqual([[[t(9), t(7)], 90]]);
		// Still running at the last sample: it runs until then.
		expect(shellGroups(lines.slice(0, 3)).map((g) => [g.calls[0]!.call.end, g.cpu])).toEqual([[t(5), 50]]);
	});

	test("a call outside a counted cgroup, or across a counter that changed, has no CPU", () => {
		const uncounted = { cgroup: null, usage: null } as Partial<CallLine>;
		const groups = shellGroups([
			start("a", 0, null, uncounted),
			start("b", 0, null, uncounted),
			end("a", 2, null, uncounted),
			end("b", 2, null, uncounted),
			start("c", 3, 5_000),
			end("c", 4, null, uncounted),
			start("d", 5, 9_000),
			end("d", 6, 1_000),
		]);
		expect(groups.map((g) => [g.calls.length, g.cpu])).toEqual([
			[1, null],
			[1, null],
			[1, null],
			[1, null],
		]);
	});
});

test("the call log keeps whole lines and reads from the day before a window's", () => {
	const env = { XDG_STATE_HOME: tempDir() };
	const line: CallLine = {
		kind: "stop",
		harness: "claude",
		session: "s",
		running: [],
		at: "2026-11-14T23:59:00.000Z",
		cgroup: null,
		usage: null,
	};
	logCall(line, env, Date.parse(line.at));
	expect(readCalls(Date.parse("2026-11-14T20:00:00Z"), env)).toEqual([line]);
	expect(readCalls(Date.parse("2026-11-15T00:30:00Z"), env)).toEqual([line]);
	expect(readCalls(Date.parse("2026-11-16T00:30:00Z"), env)).toEqual([]);
	logCall({ ...line, running: [""] }, env, Date.parse(line.at));
	logCall(line, env, Date.parse(line.at));
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		expect(readCalls(Date.parse("2026-11-14T20:00:00Z"), env)).toEqual([line, line]);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("2026-11-14.jsonl:4, not a shell call quest logged"),
		);
	} finally {
		stderr.mockRestore();
	}
});

test("reading a window also reads each earlier day a call in it began on", () => {
	const env = { XDG_STATE_HOME: tempDir() };
	const sample = (at: string) => ({ at, cgroup: "/a.scope", usage: 0 });
	const caller = { harness: "claude", session: "s", agent: null };
	const log = (line: CallLine) => logCall(line, env, Date.parse(line.at));
	// Two days back, an unrelated call; the day before, a background call handed off; the window's day, a call that
	// ran over midnight and a turn end that still lists the background task.
	log({ kind: "start", ...caller, call: "old", command: "old", ...sample("2026-11-13T10:00:00.000Z") });
	log({ kind: "end", ...caller, call: "old", task: null, ...sample("2026-11-13T10:00:01.000Z") });
	log({ kind: "start", ...caller, call: "bg", command: "bg", ...sample("2026-11-14T23:50:00.000Z") });
	log({ kind: "end", ...caller, call: "bg", task: "b1", ...sample("2026-11-14T23:50:01.000Z") });
	log({ kind: "start", ...caller, call: "late", command: "late", ...sample("2026-11-14T23:59:00.000Z") });
	log({ kind: "end", ...caller, call: "late", task: null, ...sample("2026-11-15T00:01:00.000Z") });
	log({ kind: "stop", harness: "claude", session: "s", running: ["b1"], ...sample("2026-11-15T00:02:00.000Z") });
	const read = readCalls(Date.parse("2026-11-15T00:00:00Z"), env);
	expect(read.map((l) => (l.kind === "stop" ? "stop" : `${l.kind} ${l.call}`))).toEqual([
		"start bg",
		"end bg",
		"start late",
		"end late",
		"stop",
	]);
	// The group they form began before the window, so no record of the window holds it.
	expect(shellGroups(read).map((g) => [g.start, g.calls.length])).toEqual([[Date.parse("2026-11-14T23:50:00Z"), 2]]);
});

test("reading a window also reads the day before, for a background call no line in the window names", () => {
	const env = { XDG_STATE_HOME: tempDir() };
	const sample = (at: string) => ({ at, cgroup: "/a.scope", usage: 0 });
	const caller = { harness: "claude", session: "s", agent: null };
	const log = (line: CallLine) => logCall(line, env, Date.parse(line.at));
	// A background call handed off the day before, finishing before the window's first turn end, which no longer
	// lists it; a call in the window overlapped it.
	log({ kind: "start", ...caller, call: "bg", command: "bg", ...sample("2026-11-14T23:50:00.000Z") });
	log({ kind: "end", ...caller, call: "bg", task: "b1", ...sample("2026-11-14T23:50:01.000Z") });
	log({ kind: "start", ...caller, call: "in", command: "in", ...sample("2026-11-15T00:01:00.000Z") });
	log({ kind: "end", ...caller, call: "in", task: null, ...sample("2026-11-15T00:01:30.000Z") });
	log({ kind: "stop", harness: "claude", session: "s", running: [], ...sample("2026-11-15T00:02:00.000Z") });
	const read = readCalls(Date.parse("2026-11-15T00:00:00Z"), env);
	// One group, which began before the window, rather than one starting inside it.
	expect(shellGroups(read).map((g) => [g.start, g.calls.length])).toEqual([[Date.parse("2026-11-14T23:50:00Z"), 2]]);
});
