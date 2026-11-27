// `quest wait`: poll a pull request's activity through its forge until something happens or the timeout.
import type { Forge, PullRequest, Repository, Watch } from "../core";

const POLL = 5 * 60_000;
/**
 * The last poll before a timeout starts this long before it, leaving time for its few requests;
 * activity after it is left for the returned cursor. Polling only on the 5-minute schedule left
 * up to 5 minutes before a timeout unread. A longer poll interval from the forge still wins.
 */
const FINAL_POLL = 30_000;
const MAX_SLEEP = 2_147_483_647;

export interface WaitOptions {
	since?: string;
	/** Seconds; omitted means no deadline. */
	timeout?: number;
}

export class WaitTimeout extends Error {
	/** Where to resume, when the wait got far enough to know; and how current an index's last answer was. */
	constructor(
		readonly cursor?: string,
		asOf?: { forge: string; at: string },
	) {
		super(
			`timed out waiting for pull request activity${asOf ? `; ${asOf.forge}'s last answer was current to ${asOf.at}` : ""}`,
		);
	}
}

/** The clock a wait polls on. */
export interface Clock {
	now(): number;
	sleep(milliseconds: number): Promise<unknown>;
}

/** Chooses the forge a wait reads, asking no longer than its deadline, epoch milliseconds. */
export interface ForgeChoice {
	choose(repository: Repository, deadline: number): Promise<Forge>;
}

/**
 * Wait until activity, returning plain output lines: each event, the last followed by its resume cursor. The timeout
 * covers choosing the forge too.
 */
export async function waitForActivity(
	pr: PullRequest,
	options: WaitOptions,
	choice: ForgeChoice,
	clock: Clock,
): Promise<string[]> {
	const started = clock.now();
	const deadline = options.timeout === undefined ? Infinity : started + options.timeout * 1000;
	let forge: Forge | undefined;
	let watch: Watch | undefined;
	let asOf: string | null = null;
	const timedOut = () =>
		new WaitTimeout(
			watch ? watch.resume : options.since,
			asOf === null || forge === undefined ? undefined : { forge: forge.name, at: asOf },
		);
	const pause = async (milliseconds: number) => {
		const remaining = deadline - clock.now();
		if (remaining <= 0) throw timedOut();
		await clock.sleep(Math.min(milliseconds, remaining, MAX_SLEEP));
		if (clock.now() >= deadline) throw timedOut();
	};
	try {
		forge = await choice.choose(pr, deadline);
		watch = forge.watch(pr, { since: options.since, deadline, started });
		for (;;) {
			const answer = await watch.poll();
			asOf = answer.asOf;
			const { events, cursor, pollInterval } = answer.value;
			if (events.length)
				return events.map(
					(event, index) =>
						`${event.point} ${event.type} ${event.actor} ${event.url}${index === events.length - 1 ? ` ${cursor}` : ""}`,
				);
			// The forge's poll interval is a floor: the final poll shortens only the default schedule,
			// and is skipped when that interval runs past it.
			const remaining = deadline - clock.now();
			const next = Math.min(Math.max(POLL, pollInterval), remaining - FINAL_POLL);
			await pause(next > 0 && next >= pollInterval ? next : remaining);
		}
	} catch (error) {
		// This also covers a deadline expiring inside a read, such as while a response body is read.
		if (options.timeout !== undefined && clock.now() - started >= options.timeout * 1000) throw timedOut();
		throw error;
	}
}
