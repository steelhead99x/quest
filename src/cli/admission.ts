// Agent admission: a coordinator starts or resumes an agent only while the host's memory has room
// for it, and on macOS, whose gate reads no memory, while its gate would admit work at once. It only delays the next start: agents already running are never paused or stopped.
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
	type Admission,
	type Host,
	type Limits,
	LEDGER_VERSION,
	SETTLE_MS,
	claimDirectory,
	fileHost,
	hostLimits,
	memoryRoom,
	processStart,
	room,
	type Waiting,
} from "./gate";

/**
 * How long an admitted agent counts against the host's memory, as one recent admission of the
 * gate's: an agent adds no gated work until its first build. Of 263 sub-agents on one host over three
 * weeks, the 126 that gated anything reached their first gated command in a median of 133 seconds,
 * and three quarters within 265; the rest never gated, so no later event ends the count.
 */
export const PENDING_MS = 5 * 60_000;

/** What `admit` reads and writes, replaceable in tests. */
export interface AdmissionDependencies {
	limits: Limits;
	/** The gate's ledger and the host's load and memory. */
	gate: Host;
	/** Whether agents also wait for load and the gate's queue: on macOS, where the gate reads no memory. */
	load: boolean;
	/** The agents' ledger; only its clock, ledger, liveness, and sleep are used. */
	agents: Host;
	/** A line for the user. */
	notice(text: string): void;
}

const waits: Record<Waiting, string> = {
	load: "CPU load to fall",
	memory: "free memory",
	queue: "gated commands queued on this host to start",
};

/**
 * Wait until the host can carry one more agent, then record it. The host has room while its memory
 * has room for one more command (see `memoryRoom`), counting each agent admitted in the last
 * PENDING_MS whose launcher, if it has one, still runs. CPU load and the gate's queue do not count:
 * an agent mostly waits on its model, and its builds wait in the gate. Where memory cannot bound
 * agents (see `AdmissionDependencies.load`), the host has room while the gate would admit a command
 * at once instead (see `room`), counting each such agent as one recent admission.
 *
 * `held` is the process that runs the agent, as `quest agent start` does; without it, as for a
 * coordinator's own sub-agent, nothing reports the agent's end.
 */
export async function admit(deps: AdmissionDependencies, signal: AbortSignal, held?: number): Promise<void> {
	const holder = held === undefined ? {} : { pid: held, start: processStart(held) };
	const shown = new Set<Waiting>();
	for (;;) {
		signal.throwIfAborted();
		const ledger = deps.agents.ledger();
		const now = deps.agents.now();
		// A clock stepped backward dates an entry in the future; restart it from now, so it still expires.
		if (ledger.admissions.some((entry) => entry.at > now)) {
			deps.agents.publish(
				ledger,
				ledger.admissions.map((entry) => (entry.at > now ? { ...entry, at: now } : entry)),
			);
			continue;
		}
		const pending = ledger.admissions.filter(
			(entry) => entry.at > now - PENDING_MS && (entry.pid === undefined || deps.agents.running(entry)),
		);
		const reason = deps.load
			? room(deps.limits, deps.gate, pending.length)
			: memoryRoom(deps.limits, deps.gate, pending.length)
				? null
				: "memory";
		if (reason === null) {
			const entry: Admission = { id: randomUUID(), at: now, ...holder };
			if (deps.agents.publish(ledger, [...pending, entry])) return;
			continue;
		}
		if (!shown.has(reason)) {
			shown.add(reason);
			deps.notice(`waiting for ${waits[reason]} before starting an agent`);
		}
		await deps.agents.sleep(SETTLE_MS, signal);
	}
}

/** The agents' ledger of this host, beside the gate's. */
const agentsDirectory = (gate: string) => join(dirname(dirname(gate)), `agents-v${LEDGER_VERSION}`, basename(gate));

/** The admission `quest agent` runs with: the host's own limits and ledgers. */
export function processAdmission(notice: (text: string) => void): AdmissionDependencies {
	const gate = claimDirectory();
	return {
		limits: hostLimits(),
		gate: fileHost(gate),
		load: process.platform === "darwin",
		agents: fileHost(agentsDirectory(gate)),
		notice,
	};
}

/** The admission every `quest agent` command runs, held in an object so a test can replace it. */
export const admission = { admit };
