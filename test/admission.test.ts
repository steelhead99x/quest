import { expect, test } from "vitest";
import { type AdmissionDependencies, PENDING_MS, admissionMode, admit } from "../src/cli/admission";
import { type Admission, type Host, RECENT_MS, SETTLE_MS, fileHost, processStart } from "../src/cli/gate";
import { tempDir } from "./fixture";

const GiB = 2 ** 30;
const signal = new AbortController().signal;
const me = { pid: process.pid, start: processStart(process.pid) };

/**
 * A host of 8 CPUs with real ledgers, and load, memory, a clock, and process liveness the test
 * controls; with `load`, agents also wait for load and the gate's queue, as on macOS.
 */
function host(load = false) {
	const state = {
		now: 10 * PENDING_MS,
		load: 0,
		memory: Infinity,
		dead: new Set<number>(),
		stop: Infinity,
	};
	const sleeps: number[] = [];
	const notices: string[] = [];
	const ledger = (directory: string): Host => ({
		...fileHost(directory, () => state.now),
		load: () => state.load,
		memory: () => state.memory,
		running: (admission) => admission.pid !== undefined && !state.dead.has(admission.pid),
		sleep: async (ms) => {
			// A wait that outlasts the test's patience ends it, as a cancelled caller's would.
			if (state.now >= state.stop) throw new Error("still waiting");
			sleeps.push(ms);
			state.now += ms;
		},
	});
	const deps: AdmissionDependencies = {
		limits: { load: 8, memory: 4 * GiB },
		gate: ledger(tempDir()),
		load,
		agents: ledger(tempDir()),
		notice: (text) => notices.push(text),
	};
	const gated = (admissions: Admission[]) => deps.gate.publish(deps.gate.ledger(), admissions);
	/** Whether one more agent is admitted without waiting. */
	const atOnce = async (held?: number) => {
		state.stop = state.now;
		try {
			await admit(deps, signal, held);
			return true;
		} catch (error) {
			if ((error as Error).message !== "still waiting") throw error;
			return false;
		}
	};
	return { state, sleeps, notices, deps, gated, atOnce };
}

test("a fan-out fills the host's memory, and each agent frees its share once it would have built", async () => {
	const { state, deps, sleeps, notices, atOnce } = host();
	state.memory = 15 * GiB;
	// 15 GiB less 0, 1, and 2 agents not yet building still leaves one command's 4 GiB; a fourth would not.
	expect([await atOnce(), await atOnce(), await atOnce(), await atOnce()]).toEqual([true, true, true, false]);
	// The fourth waits as the gate's callers do, and starts once the first three no longer count.
	state.stop = Infinity;
	await admit(deps, signal);
	expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(PENDING_MS);
	expect(new Set(sleeps)).toEqual(new Set([SETTLE_MS]));
	// Each waiting call names what it waits for once, however long it waits.
	expect(notices.filter((text) => text.startsWith("waiting"))).toEqual(
		Array(2).fill("waiting for free memory before starting an agent"),
	);
});

test("each agent not yet building takes one command's memory", async () => {
	const { state, atOnce } = host();
	state.memory = 9 * GiB;
	expect([await atOnce(), await atOnce(), await atOnce()]).toEqual([true, true, false]);
});

test("agents start whatever the load and the gate's queue, while memory has room", async () => {
	const { state, gated, atOnce } = host();
	state.load = 40;
	state.memory = 9 * GiB;
	// Gated commands queued, and running ones that kept every CPU busy, hold back only gated work.
	gated([
		{ id: "build", at: state.now - RECENT_MS, ...me, cores: 8 },
		{ id: "queued", at: state.now, ...me, queued: true },
	]);
	expect(await atOnce()).toBe(true);
	// A recent gated admission takes one command's memory, as the gate counts it.
	state.now += PENDING_MS;
	gated([{ id: "test", at: state.now, ...me }]);
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
});

test("only Linux bounds agents by memory alone, reading the user's background slice as the gate does", () => {
	expect(admissionMode("linux", 1000)).toEqual({ load: false, uid: 1000 });
	// macOS and Windows keep `room`, whose CPU count bounds pending agents and queued commands; neither has a slice.
	expect(admissionMode("darwin", 501)).toEqual({ load: true });
	expect(admissionMode("win32", undefined)).toEqual({ load: true });
});

test("on macOS, agents fill the load's headroom as the gate's callers would", async () => {
	const { state, notices, atOnce } = host(true);
	state.load = 5;
	// Load 5 plus 0, 1, and 2 agents not yet building stays under 8 CPUs; a fourth would not.
	expect([await atOnce(), await atOnce(), await atOnce(), await atOnce()]).toEqual([true, true, true, false]);
	expect(notices).toEqual(["waiting for CPU load to fall before starting an agent"]);
});

test("on Windows, which reports no load, pending agents still count against the CPUs", async () => {
	const { state, atOnce } = host(true);
	state.load = 0;
	const admitted: boolean[] = [];
	for (let agent = 0; agent < 9; agent++) admitted.push(await atOnce());
	expect(admitted).toEqual([...Array(8).fill(true), false]);
});

test("on macOS, a queued or running gated command holds agents back as it would another command", async () => {
	const { state, gated, atOnce, notices } = host(true);
	state.load = 6;
	// One command queued for the gate: an arrival would wait behind it only once the host is short.
	gated([{ id: "queued", at: state.now, ...me, queued: true }]);
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
	expect(notices.at(-1)).toContain("gated commands queued");
	// Running commands that kept every CPU busy hold the host whatever the load average says.
	state.load = 0;
	state.now += PENDING_MS;
	gated([{ id: "build", at: state.now - RECENT_MS, ...me, cores: 8 }]);
	expect(await atOnce()).toBe(false);
	// A host loaded by work no gate holds still starts one agent at a time.
	state.now += PENDING_MS;
	gated([]);
	state.load = 40;
	expect([await atOnce(), await atOnce()]).toEqual([true, false]);
});

test("an agent whose launcher exited no longer counts, and one still running counts only while it may yet build", async () => {
	const { state, atOnce } = host();
	state.memory = 4 * GiB;
	expect([await atOnce(4242), await atOnce()]).toEqual([true, false]);
	state.dead.add(4242);
	expect(await atOnce()).toBe(true);
	state.now += PENDING_MS;
	expect([await atOnce(4243), await atOnce()]).toEqual([true, false]);
	state.now += PENDING_MS;
	expect(await atOnce()).toBe(true);
});

test("an agent dated in the future by a clock stepped backward counts from now, and still expires", async () => {
	const { state, deps, sleeps } = host();
	state.memory = 4 * GiB;
	deps.agents.publish(deps.agents.ledger(), [{ id: "ahead", at: state.now + 12 * PENDING_MS }]);
	await admit(deps, signal);
	expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(PENDING_MS);
});
