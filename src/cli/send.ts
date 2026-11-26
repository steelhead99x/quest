// Sending each session's record, and the breakages its PRs name, to Kixel Quest, for each repository it serves. The stop hook only queues the session;
// one sender per user, run by its service manager, rebuilds each queued session's record, with its sub-agents', and
// posts them, keeping what failed for the next pass, and queues a sent session again once a PR opens on a branch its
// record could not name a PR for. A record replaces its earlier copy, so a resend never doubles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { type BreakageRecord, type Finder, type RecordUpload, type Repository, parseUpload } from "../core";
import { culpritOf } from "./breakage";
import { CLOCK_SKEW, type GitHubDependencies, GitHub } from "../github/client";
import { baseRepository } from "./claims";
import { KixelQuest, Refused } from "./forge";
import { discoveryEnv } from "./git";
import { readRemote, remoteRepository } from "./github";
import { eachLine } from "./messages";
import { questRoot } from "./rules";
import { type Labeled, type SplitDependencies, type Steps, labelSession, readSteps, splitOf } from "./split";
import {
	type Pins,
	type Pull,
	type Reached,
	type Reviewed,
	type Session,
	fixBreakages,
	currentNamer,
	currentNames,
	fold,
	heading,
	key,
	readPull,
	sessionRecords,
	unheaded,
	updatedPulls,
} from "./usage";
import { kixelUrl, tokenFor, tokensPath } from "./tokens";
import { type LoggedWait } from "./waits";
import type { CallLine } from "./calls";

/** One session the stop hook queued. */
export interface Pending {
	harness: string;
	session: string;
	/** Its transcript's first instant, epoch ms, so token-max reads all of it. */
	start: number;
	/** A fresh ID per stop, naming its own queue file, so a sender removes only the stops it sent. */
	queued: string;
	/** The Kixel Quest the hook checked a token for, which this record is sent to whatever environment the sender runs in. */
	url: string;
	/** The checkout's quest root, its `origin` on GitHub as `owner/repo`, and where its quest tree sits below the top level. */
	root: string;
	origin: string;
	prefix: string;
	/**
	 * For a session `quest review` started, the PR it recorded on, the branch it reviewed, and the role it played
	 * there, which the sender takes over what it infers from the session's checkout and the PR's `## Review` record.
	 */
	reviewed?: Reviewed;
	/**
	 * On a resend, the instant, epoch ms, its earlier upload read PRs from, so the resend reads at least as far back and
	 * names every PR that upload did.
	 */
	read?: number;
}

/** Where the sender keeps its queue and what it has said. */
export function stateDirectory(env: NodeJS.ProcessEnv): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quest", "records");
}

/** The marker of a Kixel Quest that refused a token, which a new token clears. */
const refusal = (env: NodeJS.ProcessEnv, url: string, token: string) =>
	join(stateDirectory(env), "refused", digest(`${url}\0${token}`));

function refuse(env: NodeJS.ProcessEnv, url: string, token: string): void {
	mkdirSync(join(stateDirectory(env), "refused"), { recursive: true, mode: 0o700 });
	writeFileSync(refusal(env, url, token), "");
}

/** Say `notice` the first time only, by `key`, returning it then and null after. */
function once(env: NodeJS.ProcessEnv, key: string, notice: string): string | null {
	const dir = join(stateDirectory(env), "said");
	const marker = join(dir, digest(key));
	if (existsSync(marker)) return null;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(marker, `${key}\n`);
	return notice;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The first instant a transcript records, epoch ms, or null when it records none. */
function transcriptStart(path: string): number | null {
	let found: number | null = null;
	eachLine(path, (line) => {
		const at = /"timestamp"\s*:\s*"([^"]+)"/.exec(line)?.[1];
		const ms = at === undefined ? NaN : Date.parse(at);
		if (Number.isNaN(ms)) return true;
		found = ms;
		return false;
	});
	return found;
}

/**
 * A session to queue: a stop hook's input, as Claude Code and Codex send it, which names its transcript, or a session
 * `quest review` started, which knows its own first instant, epoch ms, and the PR, branch, and role it reviewed in.
 */
export type Stopped = { harness: string; session: string; cwd: string } & (
	{ transcript: string } | ({ start: number } & Reviewed)
);

/** What `queue` did, for the hook to say. */
export interface Queued {
	/** Each notice the person has not seen yet. */
	notices: string[];
	/** Whether the session was queued. */
	queued: boolean;
}

/**
 * Queue the session's record for Kixel Quest, in a checkout that uses Quest. A user holding no token for it
 * queues nothing and is told once. A sender's last failure, if the person has not seen it, is said too.
 */
export function queue(stopped: Stopped, env: NodeJS.ProcessEnv = process.env): Queued {
	const notices: string[] = [];
	const failure = unseenFailure(env);
	if (failure) notices.push(failure);
	const root = questRoot(stopped.cwd);
	if (root === null) return { notices, queued: false };
	const said = (key: string, notice: string) => {
		const text = once(env, key, notice);
		if (text) notices.push(text);
		return { notices, queued: false };
	};
	const run = (args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: discoveryEnv() });
	const remote = readRemote(root, "origin");
	const origin = remote === null ? null : remoteRepository(remote).repository;
	// A checkout off GitHub has no PRs for a record to name.
	if (origin === null) return { notices, queued: false };
	const repository = `${origin.owner}/${origin.repo}`.toLowerCase();
	const url = kixelUrl(env);
	const token = tokenFor(url, env);
	if (token === null)
		return said(
			`token:${url}`,
			`quest: ${tokensPath(env)} holds no token for ${url}, so this host sends it no session records.`,
		);
	if (existsSync(refusal(env, url, token))) return { notices, queued: false };
	let start: number;
	let reviewed: Reviewed | undefined;
	if ("start" in stopped) {
		start = stopped.start;
		reviewed = { pull: stopped.pull, branch: stopped.branch, role: stopped.role };
	} else {
		const first = transcriptStart(stopped.transcript);
		if (first === null) throw new Error(`${stopped.transcript} records no instant, so its session cannot be read`);
		start = first;
	}
	const dir = enqueue(env, {
		harness: stopped.harness,
		session: stopped.session,
		start,
		queued: randomUUID(),
		url,
		root,
		origin: repository,
		prefix: run(["rev-parse", "--show-prefix"]).stdout.trim(),
		...(reviewed && { reviewed }),
	});
	const sender = senderRuns(env);
	if (!sender.runs)
		// Said once per outage: the PID of the sender that stopped names it, or none for a host that never ran one.
		said(
			`down:${sender.pid}`,
			`quest: no session record sender runs on this host, so this session's record waits in ${dir} with any others; start it with \`quest records install\`.`,
		);
	return { notices, queued: true };
}

/**
 * Write `pending` to the queue, returning the queue's directory. Each stop gets a file of its own, never rewritten, so
 * a sender removes only the stops it read. Written whole, then renamed, so the sender never reads half a file.
 */
function enqueue(env: NodeJS.ProcessEnv, pending: Pending): string {
	const dir = join(stateDirectory(env), "pending");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${pending.queued}.json`);
	writeFileSync(`${path}.new`, JSON.stringify(pending));
	renameSync(`${path}.new`, path);
	return dir;
}

/** The sender's last failure when the person has not seen it yet, marking it seen. */
function unseenFailure(env: NodeJS.ProcessEnv): string | null {
	const path = join(stateDirectory(env), "failure");
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const seen = `${path}.seen`;
	if (existsSync(seen) && readFileSync(seen, "utf8") === text) return null;
	writeFileSync(seen, text);
	return `quest: ${text.trim()}`;
}

function writeFailure(env: NodeJS.ProcessEnv, text: string): void {
	const dir = stateDirectory(env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "failure"), `${text}\n`);
}

/** What the sender reads and posts with. */
export interface SendDependencies {
	env: NodeJS.ProcessEnv;
	github(): GitHubDependencies;
	/** token-max's sessions on this host since an instant, or null when it is not installed. */
	sessions(since: Date): Session[] | null;
	waits(since: number): LoggedWait[];
	calls(since: number): CallLine[];
	/** Asks the models that split each session's time. */
	ask: SplitDependencies["ask"];
	fetch: typeof globalThis.fetch;
	now(): number;
	sleep(ms: number): Promise<unknown>;
	/** The time between passes, and a failing group's first wait. */
	interval: number;
}

/** How long the sender waits between passes, so a busy host's stops cannot spend its GitHub quota. */
export const SEND_INTERVAL = 60_000;

/** The outcome of one upload. */
export interface Sent {
	endpoint: string;
	repository: string;
	records: number;
	breakages: number;
	/** The endpoint refused the token, so the records were dropped. */
	refused: boolean;
}

/** Where the running sender records its process ID, for the stop hook to check. */
const pidPath = (env: NodeJS.ProcessEnv) => join(stateDirectory(env), "sender.pid");

/**
 * Whether a sender runs: the process the sender's PID file names is alive. A reused PID reads as running, which only
 * delays the notice; the queue keeps every record meanwhile.
 */
function senderRuns(env: NodeJS.ProcessEnv): { runs: boolean; pid: string } {
	const path = pidPath(env);
	const pid = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
	const owner = Number(pid);
	return { runs: Number.isSafeInteger(owner) && owner > 0 && alive(owner), pid };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run the sender until stopped: each `interval`, send every queued session's record, keeping what failed for the
 * next pass and leaving the failure for the stop hook to say. The user's service manager runs exactly one, so no two
 * passes ever overlap and uploads of a session reach the store in order.
 */
export async function runSender(deps: SendDependencies, log: (line: string) => void): Promise<never> {
	const dir = stateDirectory(deps.env);
	mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	writeFileSync(pidPath(deps.env), String(process.pid));
	for (;;) {
		try {
			for (const each of await sendPass(deps))
				log(
					each.refused
						? `${each.endpoint} refused the token for ${each.repository}; ${each.records} records dropped`
						: `sent ${each.records} records and ${each.breakages} breakages of ${each.repository} to ${each.endpoint}`,
				);
		} catch (error) {
			log(error instanceof Error ? error.message : String(error));
		}
		await deps.sleep(deps.interval);
	}
}

/**
 * Send every queued session's record once, with those of its sub-agents on this host, one upload per repository, to
 * the Kixel Quest its hook queued it for, with that URL's token. A repository Kixel Quest does not serve has its sessions dropped,
 * said once, so it costs no later request. An upload refused for access drops its sessions and says so once; any other
 * failure keeps them queued for the next pass, records it for the stop hook, and throws. A session queued again while
 * an upload ran stays queued.
 */
export async function sendPass(deps: SendDependencies): Promise<Sent[]> {
	const dir = stateDirectory(deps.env);
	try {
		return await sendOnce(deps, dir);
	} catch (error) {
		writeFailure(
			deps.env,
			`session records were not sent and stay queued, retried with backoff: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
}

const groupId = (p: Pending) => JSON.stringify([p.url, p.origin, p.prefix]);

async function sendOnce(deps: SendDependencies, dir: string): Promise<Sent[]> {
	const queued = readdirSync(join(dir, "pending"))
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const path = join(dir, "pending", name);
			return { path, pending: JSON.parse(readFileSync(path, "utf8")) as Pending };
		});
	// Each record goes to the Kixel Quest its hook queued it for, not the one this sender's environment names.
	const byUrl = new Map<string, typeof queued>();
	for (const q of queued) byUrl.set(q.pending.url, [...(byUrl.get(q.pending.url) ?? []), q]);
	const out = { sent: [] as Sent[], failures: [] as string[], notes: [] as string[] };
	let due = false;
	for (const [url, records] of byUrl) {
		try {
			due = (await sendTo(deps, dir, url, records, out)) || due;
		} catch (error) {
			// One Kixel Quest's failure never holds back another's records.
			out.failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// A pass with nothing to say leaves the last failure for the stop hook, which a quiet group's backoff still owes.
	return due || out.failures.length > 0 || out.notes.length > 0
		? finish(deps, dir, out.sent, out.failures, out.notes)
		: out.sent;
}

/**
 * Send `queued`, all queued for `url`, adding to `out`. Returns whether the pass has something to say, so the last
 * failure is replaced or cleared, rather than left for a pass in which every group sat out its backoff.
 */
async function sendTo(
	deps: SendDependencies,
	dir: string,
	url: string,
	queued: { path: string; pending: Pending }[],
	out: { sent: Sent[]; failures: string[]; notes: string[] },
): Promise<boolean> {
	const { sent, failures, notes } = out;
	const token = tokenFor(url, deps.env);
	// The user removed the token since the session was queued, or Kixel Quest refused it: these are dropped.
	if (token === null || existsSync(refusal(deps.env, url, token))) {
		for (const q of queued) settle(q);
		return false;
	}
	const groups = new Map<string, typeof queued>();
	for (const q of queued) {
		const id = groupId(q.pending);
		groups.set(id, [...(groups.get(id) ?? []), q]);
	}
	// A group backing off sits the pass out, so it neither reruns token-max nor widens the others' window.
	for (const id of [...groups.keys()]) if ((readBackoff(deps.env, id)?.next ?? 0) > deps.now()) groups.delete(id);
	const client = new GitHub(deps.github());
	const failed = (id: string, origin: string, error: unknown) => {
		const wait = backOff(deps, id);
		failures.push(
			`${origin} to ${url}: ${error instanceof Error ? error.message : String(error)} (tried again in ${Math.round(wait / 60_000)} minutes)`,
		);
	};
	// Records name the repository PRs open on, which a fork's is not. Kixel Quest refuses a whole upload naming one it
	// does not index, so a group it does not serve is dropped without running token-max.
	const kixel = new KixelQuest(
		url,
		token,
		{
			env: deps.env,
			fetch: deps.fetch,
			now: deps.now,
			sleep: async () => {},
			github: deps.github,
			remedy: "its records stay queued",
		},
		false,
	);
	/** Kixel Quest refused the token, which every group shares: nothing more is sent, and what is queued is dropped. */
	const refuseAll = (status: number, repository: string, records: number, breakages: number) => {
		refuse(deps.env, url, token);
		for (const q of queued) settle(q);
		for (const q of queued) clearBackoff(deps.env, groupId(q.pending));
		notes.push(
			`${url} refused this host's token (${status}), so it is sent no more session records until the token changes`,
		);
		sent.push({ endpoint: `${url}/records`, repository, records, breakages, refused: true });
	};
	const bases = new Map<string, Repository>();
	for (const [id, group] of [...groups]) {
		const { origin, prefix } = group[0]!.pending;
		try {
			const [owner, repo] = origin.split("/") as [string, string];
			const repository = await baseRepository(client, { owner, repo }, prefix);
			if (await kixel.serves(repository)) {
				bases.set(id, repository);
				continue;
			}
			// Dropped, not kept: an unserved repository's stops would otherwise pile up in `pending/` and cost a GitHub
			// request every pass to resolve again.
			for (const q of group) settle(q);
			clearBackoff(deps.env, id);
			const unserved = once(
				deps.env,
				`unserved:${url}:${key(repository)}`,
				`${url} does not serve ${key(repository)}, so its sessions' records are dropped on this host.`,
			);
			if (unserved !== null) notes.push(unserved);
		} catch (error) {
			if (error instanceof Refused) {
				refuseAll(error.status, origin, 0, 0);
				return true;
			}
			failed(id, origin, error);
		}
		groups.delete(id);
	}
	const active = [...groups.values()].flat();
	if (active.length === 0) return false;
	const since = Math.min(...active.map((q) => q.pending.start));
	const listed = deps.sessions(new Date(since));
	if (listed === null)
		throw new Error(
			"token-max is not installed, so no record can be priced; install it with `cargo install --locked token-max`",
		);
	const current = currentNamer(client);
	const waits = deps.waits(since);
	const calls = deps.calls(since);
	for (const [id, group] of groups) {
		const { origin } = group[0]!.pending;
		const roots = new Set(group.map((q) => q.pending.root));
		try {
			// Looked up here, so a repository GitHub fails to answer for holds back only the groups it fails for.
			const exported = await currentNames(current, listed);
			const { kept } = fold(exported);
			const byId = new Map(kept.flatMap((s) => (s.id === null ? [] : [[`${s.harness}\0${s.id}`, s] as const])));
			const repository = bases.get(id)!;
			// PRs are read from the last upload's read, if earlier, so a fix that merged after its sessions were sent,
			// as through the merge queue, still reaches the store with the next session. A resend reads from its earlier
			// upload's read too, if earlier, so it drops no PR that upload named.
			const read = deps.now() - CLOCK_SKEW;
			const from = Math.min(
				since,
				readCursor(deps.env, id) ?? since,
				...group.map((q) => q.pending.read ?? Number.POSITIVE_INFINITY),
			);
			const pulls: Pull[] = await updatedPulls(client, repository, from);
			const emit = new Set<Session>();
			const missing: typeof group = [];
			for (const q of group) {
				const session = byId.get(`${q.pending.harness}\0${q.pending.session}`);
				if (session) emit.add(session);
				else missing.push(q);
			}
			// A session token-max no longer lists, as when its transcript was deleted, can never be built: it is
			// dropped and said, so it does not hold back the rest of its group forever. One remembered to name a PR
			// later is dropped silently, since its first upload sent everything but that PR.
			for (const q of missing) {
				settle(q);
				if (forget(deps.env, id, q.pending)) continue;
				notes.push(
					`token-max lists no ${q.pending.harness} session ${q.pending.session} on this host, so its record was dropped`,
				);
			}
			// Pinned under the origin's current name, so a repository renamed since the review still matches its PR.
			const here = await current(origin);
			const pins: Pins = new Map(
				[...bySession(group)].flatMap(([name, pending]) =>
					pending.reviewed ? [[name, { ...pending.reviewed, origin: here }] as const] : [],
				),
			);
			const repositories = new Set([here, key(repository)]);
			// A sub-agent stops without the stop hook naming it, so each queued session brings its own, routed as its
			// own checkout routes it, found from the nearest folder still there: a checkout must be a queued one's, or
			// name the same origin. With no checkout left, every repository token-max resolved for it
			// must be this group's.
			const routed = async (s: Session): Promise<boolean> => {
				// Repositories token-max resolved that are none of this group's, as for a deleted nested clone of
				// another, rule it out whatever checkout now holds its folder.
				if (
					s.repositories !== null &&
					s.repositories.length > 0 &&
					!s.repositories.some((r) => repositories.has(r))
				)
					return false;
				if (s.cwd !== null && insideCheckout(s.cwd)) {
					const own = questRoot(s.cwd);
					if (own === null) return false;
					if (roots.has(own)) return true;
					const remote = readRemote(own, "origin");
					const named = remote === null ? null : remoteRepository(remote).repository;
					return named !== null && (await current(key(named))) === here;
				}
				return (
					s.repositories !== null &&
					s.repositories.length > 0 &&
					s.repositories.every((r) => repositories.has(r))
				);
			};
			for (let grew = true; grew;) {
				grew = false;
				for (const s of kept) {
					const parent = s.parent === null ? undefined : byId.get(`${s.harness}\0${s.parent}`);
					if (
						s.id !== null &&
						!emit.has(s) &&
						parent !== undefined &&
						emit.has(parent) &&
						(await routed(s))
					) {
						emit.add(s);
						grew = true;
					}
				}
			}
			if (emit.size === 0) continue;
			// Each session's new steps are labeled before its record is built, so its record carries its split.
			const labeled = new Map<Session, { steps: Steps; labeled: Labeled }>();
			for (const s of emit) {
				// A transcript with lines token-max could not read either is sent unsplit, as it is sent without waits.
				if (s.id === null || s.host !== null || s.skippedLines > 0) continue;
				// Labeling never holds a record back: a session whose transcript reads in a shape quest does not know, or
				// that no model could label, is sent unsplit and said, and its next stop tries the parts still unlabeled.
				try {
					const steps = readSteps(s.harness, s.files);
					const labels = await labelSession(s.harness, s.id, steps, {
						ask: deps.ask,
						state: dir,
						env: deps.env,
					});
					labeled.set(s, { steps, labeled: labels });
				} catch (error) {
					// A transcript deleted since token-max read it has no split to say.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					notes.push(
						`${s.harness} session ${s.id} was sent without its time split: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			const records = sessionRecords({
				repository: key(repository),
				sessions: kept,
				evidence: exported,
				pulls,
				waits,
				calls,
				emit,
				since,
				pins,
				split: (s, waits, from) => {
					const read = labeled.get(s);
					return read ? splitOf(read.steps, read.labeled, waits, from) : null;
				},
			});
			const upload: RecordUpload = {
				records: [...records.values()],
				breakages: await fixBreakages({ client, repository, pulls }),
			};
			const due = await resendsDue(deps.env, id, pulls, group, current);
			const endpoint = `${url}/records`;
			const response = await post(deps.fetch, endpoint, token, upload);
			if (response.status === 401 || response.status === 403) {
				refuseAll(response.status, key(repository), upload.records.length, upload.breakages.length);
				break;
			}
			if (!response.ok)
				throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
			clearBackoff(deps.env, id);
			remember(deps.env, id, { group, emit, byId, from, waiting: unheaded([...emit], exported, pulls, pins) });
			for (const path of due.forget) rmSync(path, { force: true });
			for (const pending of due.resend) enqueue(deps.env, { ...pending, queued: randomUUID() });
			// Only once every resend these PRs call for is queued, so a pass that fails before then reads them again.
			writeCursor(deps.env, id, read);
			for (const q of group) settle(q);
			sent.push({
				endpoint,
				repository: key(repository),
				records: upload.records.length,
				breakages: upload.breakages.length,
				refused: false,
			});
		} catch (error) {
			failed(id, origin, error);
		}
	}
	return true;
}

/** End a pass: throw its failures, else leave its notes for the stop hook to say, or clear the last failure. */
function finish(deps: SendDependencies, dir: string, sent: Sent[], failures: string[], notes: string[]): Sent[] {
	if (failures.length) throw new Error([...notes, ...failures].join("; "));
	if (notes.length) writeFailure(deps.env, notes.join("; "));
	else rmSync(join(dir, "failure"), { force: true });
	return sent;
}

/**
 * `text` as epoch ms when it is an ISO 8601 date and time with an explicit `Z` or offset on a real calendar day, else
 * null: `Date.parse` alone takes a bare date as UTC midnight, a time without an offset as this host's, and rolls an
 * impossible day such as February 30 into the next month.
 */
export function parseInstant(text: string): number | null {
	const match =
		/^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(text);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	const at = Date.parse(text);
	return Number.isNaN(at) ? null : at;
}

/** An incident to report, as a deploy or alert hands it to `quest records incident`. */
export interface Incident {
	/** A directory in the checkout whose repository it is reported for. */
	cwd: string;
	/** The reporter's stable ID for it, such as the alert's URL; reporting the same ID again replaces it. */
	id: string;
	found: Finder;
	/** The PR that caused it, or null while unknown, which leaves it open. */
	pull: number | null;
	/** When it was found, epoch ms. */
	at: number;
}

/**
 * Post `incident` as a breakage to Kixel Quest, with the token the user paired with it, and return it. Unlike the
 * sender, it posts at once and fails loud on anything Kixel Quest does not take, refusal and an unserved repository
 * included, since a deploy or alert calls it once and nothing retries.
 */
export async function reportIncident(
	incident: Incident,
	deps: Pick<SendDependencies, "env" | "github" | "fetch">,
): Promise<BreakageRecord> {
	const root = questRoot(resolve(incident.cwd));
	if (root === null) throw new Error(`${incident.cwd} is not in a checkout that uses Quest`);
	const url = kixelUrl(deps.env);
	const token = tokenFor(url, deps.env);
	if (token === null) throw new Error(`${tokensPath(deps.env)} holds no token for ${url}`);
	const remote = readRemote(root, "origin");
	const origin = remote === null ? null : remoteRepository(remote).repository;
	if (origin === null) throw new Error("origin is not on GitHub");
	const client = new GitHub(deps.github());
	const prefix = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
		encoding: "utf8",
		env: discoveryEnv(),
	}).stdout.trim();
	const repository = await baseRepository(client, origin, prefix);
	let culprit: BreakageRecord["culprit"] = null;
	if (incident.pull !== null) {
		const found = await readPull(client, repository, incident.pull);
		if (found === null) throw new Error(`${key(repository)} has no PR #${incident.pull}`);
		culprit = culpritOf(found);
	}
	const breakage: BreakageRecord = {
		repository: key(repository),
		culprit,
		fix: null,
		incident: incident.id,
		found: incident.found,
		at: new Date(incident.at).toISOString(),
	};
	const endpoint = `${url}/records`;
	const response = await post(deps.fetch, endpoint, token, { records: [], breakages: [breakage] });
	if (!response.ok)
		throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
	return breakage;
}

/** POST `upload` to `endpoint` with `token`, after checking it is one the store's own `parseUpload` takes. */
async function post(
	fetch: typeof globalThis.fetch,
	endpoint: string,
	token: string,
	upload: RecordUpload,
): Promise<Response> {
	try {
		parseUpload(upload);
	} catch (error) {
		throw new Error(`this quest built an upload its own parseUpload refuses: ${(error as Error).message}`);
	}
	// A redirect would turn the POST into a GET on some other page, whose 200 would settle records the
	// endpoint never received, so the endpoint must answer at the URL it is configured with.
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(upload),
		redirect: "manual",
	});
	if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400))
		throw new Error(
			`${endpoint} answered a redirect (${response.status}${response.headers.get("location") ? ` to ${response.headers.get("location")}` : ""}), so nothing was sent; set the records endpoint to the URL that takes the upload`,
		);
	return response;
}

/** The longest a failing group waits between tries. */
const MAX_BACKOFF = 6 * 3_600_000;

/** A failing group's consecutive failures and the instant it may next be tried. */
interface Backoff {
	failures: number;
	next: number;
}

const cursorPath = (env: NodeJS.ProcessEnv, id: string) => join(stateDirectory(env), "read", digest(id));

/** When group `id`'s last successful upload read its PRs, epoch ms, or null; an unreadable file reads as none. */
function readCursor(env: NodeJS.ProcessEnv, id: string): number | null {
	try {
		const at = Number(readFileSync(cursorPath(env, id), "utf8"));
		return Number.isFinite(at) && at > 0 ? at : null;
	} catch {
		return null;
	}
}

function writeCursor(env: NodeJS.ProcessEnv, id: string, at: number): void {
	mkdirSync(join(stateDirectory(env), "read"), { recursive: true, mode: 0o700 });
	const path = cursorPath(env, id);
	writeFileSync(`${path}.new`, String(at));
	renameSync(`${path}.new`, path);
}

const backoffPath = (env: NodeJS.ProcessEnv, id: string) => join(stateDirectory(env), "backoff", digest(id));

/** A group's backoff, or null without one; an unreadable file reads as none, so it can never block every group. */
function readBackoff(env: NodeJS.ProcessEnv, id: string): Backoff | null {
	try {
		const value = JSON.parse(readFileSync(backoffPath(env, id), "utf8")) as Partial<Backoff> | null;
		return Number.isSafeInteger(value?.failures) && Number.isFinite(value?.next) ? (value as Backoff) : null;
	} catch {
		return null;
	}
}

/**
 * Record another failure of group `id`, doubling its wait from one interval up to `MAX_BACKOFF`, so a rejection that
 * resending cannot fix, such as a store refusing a newer record, costs a pass a few times a day while its records
 * stay queued. Returns the wait.
 */
function backOff(deps: SendDependencies, id: string): number {
	const failures = (readBackoff(deps.env, id)?.failures ?? 0) + 1;
	const wait = Math.min(deps.interval * 2 ** Math.min(failures - 1, 30), MAX_BACKOFF);
	mkdirSync(join(stateDirectory(deps.env), "backoff"), { recursive: true, mode: 0o700 });
	// Written whole, then renamed, as queue files are, so a crash mid-write leaves the old file or none.
	const path = backoffPath(deps.env, id);
	writeFileSync(`${path}.new`, JSON.stringify({ failures, next: deps.now() + wait } satisfies Backoff));
	renameSync(`${path}.new`, path);
	return wait;
}

function clearBackoff(env: NodeJS.ProcessEnv, id: string): void {
	rmSync(backoffPath(env, id), { force: true });
}

/**
 * A sent session whose tree's record could not name a PR one of its branches may yet head: the latest branch of it or
 * a sub-agent sent with it headed no PR. It is queued again once one does, so that PR's cost and time count it.
 */
interface Remembered {
	/** Its stop as last queued, with where that upload read PRs from, queued again under a new ID to resend it. */
	pending: Pending;
	/** Its transcript's files: once none is left, token-max lists it no more, so it is forgotten. */
	files: string[];
	/** Each latest branch in its tree that headed no PR when it was last sent. */
	waiting: Reached[];
}

/** Group `id`'s remembered sessions, a file each, so a pass reads only its own group's. */
const rememberedDir = (env: NodeJS.ProcessEnv, id: string) => join(stateDirectory(env), "remembered", digest(id));
const rememberedPath = (env: NodeJS.ProcessEnv, id: string, pending: Pending) =>
	join(rememberedDir(env, id), `${digest(`${pending.harness}\0${pending.session}`)}.json`);

/**
 * Decide afresh, for each session of `group` the upload sent, whether to remember it: when the latest branch of any
 * session in the tree it was sent with, it and its sub-agents, headed no PR. The whole tree counts, since
 * `buildRecords` passes PRs between parent and sub-agent, so a PR opening on a sub-agent's branch changes its parent's
 * record too.
 */
const recorded = (pending: Pending | undefined) => (pending?.reviewed?.pull ?? null) !== null;

/**
 * Each queued session's pending file, by `harness\0session`. A session that stopped twice is queued twice and either
 * copy stands for it, except that a resumed reviewer's copy naming the PR its round recorded on outlasts one from a
 * round before that PR opened, whichever is read last.
 */
function bySession(group: { pending: Pending }[]): Map<string, Pending> {
	const sessions = new Map<string, Pending>();
	for (const { pending } of group) {
		const name = `${pending.harness}\0${pending.session}`;
		if (recorded(sessions.get(name)) && !recorded(pending)) continue;
		sessions.set(name, pending);
	}
	return sessions;
}

function remember(
	env: NodeJS.ProcessEnv,
	id: string,
	sent: {
		group: { pending: Pending }[];
		emit: Set<Session>;
		byId: Map<string, Session>;
		/** Where the upload's PR read began. */
		from: number;
		waiting: Map<Session, Reached>;
	},
): void {
	const children = new Map<string, Session[]>();
	for (const s of sent.emit) {
		if (s.parent === null) continue;
		const parent = `${s.harness}\0${s.parent}`;
		children.set(parent, [...(children.get(parent) ?? []), s]);
	}
	const roots = bySession(sent.group);
	for (const [name, pending] of roots) {
		const root = sent.byId.get(name);
		if (root === undefined || !sent.emit.has(root)) continue;
		const tree = new Set([root]);
		for (const s of tree) for (const child of children.get(`${s.harness}\0${s.id}`) ?? []) tree.add(child);
		const waiting = [
			...new Map(
				[...tree].flatMap((s) => {
					const reached = sent.waiting.get(s);
					return reached ? [[JSON.stringify(reached), reached] as const] : [];
				}),
			).values(),
		];
		const path = rememberedPath(env, id, pending);
		if (waiting.length === 0) {
			rmSync(path, { force: true });
			continue;
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(
			`${path}.new`,
			JSON.stringify({
				pending: { ...pending, read: sent.from },
				files: root.files,
				waiting,
			} satisfies Remembered),
		);
		renameSync(`${path}.new`, path);
	}
}

/** Forget `pending`'s session, returning whether it was remembered. */
function forget(env: NodeJS.ProcessEnv, id: string, pending: Pending): boolean {
	const path = rememberedPath(env, id, pending);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

/**
 * What group `id`'s remembered sessions call for once `pulls` are read: each whose PR now heads one of its waiting
 * branches, to queue again so the group's next pass rebuilds its tree, and each whose transcript is gone, to forget.
 * The group's sessions in `sent` were just rebuilt, so they are left as `remember` decides. Read before the upload, so
 * a failed lookup fails before the store has the records, not after.
 */
async function resendsDue(
	env: NodeJS.ProcessEnv,
	id: string,
	pulls: Pull[],
	sent: { pending: Pending }[],
	current: (name: string) => Promise<string>,
): Promise<{ forget: string[]; resend: Pending[] }> {
	const due = { forget: [] as string[], resend: [] as Pending[] };
	const dir = rememberedDir(env, id);
	if (!existsSync(dir)) return due;
	const fresh = new Set(sent.map((q) => rememberedPath(env, id, q.pending)));
	const heads = heading(pulls);
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (!name.endsWith(".json") || fresh.has(path)) continue;
		const kept = readRemembered(path);
		// An unreadable file loses only the resend of a record already sent once, so it never blocks the group.
		if (kept === null || !kept.files.some((file) => existsSync(file))) due.forget.push(path);
		else {
			// A branch remembered before its repository moved names the old one, which GitHub's PRs no longer do.
			const waiting = await Promise.all(
				kept.waiting.map(async (reached) => ({
					...reached,
					repositories: [...new Set(await Promise.all(reached.repositories.map(current)))],
				})),
			);
			if (waiting.some(heads)) due.resend.push(kept.pending);
		}
	}
	return due;
}

function readRemembered(path: string): Remembered | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Remembered> | null;
		return typeof value?.pending === "object" &&
			value.pending !== null &&
			Array.isArray(value.files) &&
			value.files.every((file) => typeof file === "string") &&
			Array.isArray(value.waiting) &&
			value.waiting.every(
				(each) =>
					typeof each?.name === "string" &&
					typeof each.first === "number" &&
					Array.isArray(each.repositories) &&
					each.repositories.every((r) => typeof r === "string"),
			)
			? (value as Remembered)
			: null;
	} catch {
		return null;
	}
}

/** Whether a checkout still holds `dir` or the nearest of its parents that exists, as `questRoot` finds it. */
function insideCheckout(dir: string): boolean {
	for (let at = dir; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) return true;
		if (dirname(at) === at) return false;
	}
}

/** Drop a stop the sender read; a later stop of the same session has a file of its own and stays queued. */
function settle(q: { path: string }): void {
	rmSync(q.path, { force: true });
}

/** Lower this process's priority, since the sender works in the background. */
export function background(): void {
	try {
		setPriority(19);
	} catch {
		// A host that refuses only leaves it at normal priority.
	}
}
