// What quest reads from and writes to a forge, as interfaces with a backend per forge: pull request, check, review,
// hold, and queue state, claims, activity to wait on, and a PR's discussion; and opening, editing, readying, commenting on, holding,
// and picking PRs. Its types are the wire format Kixel Quest serves them in, so both sides parse the same shapes and
// neither guesses.
import { TIERS, type Tier } from "./risk";

/** A repository on its forge, by owner and name. */
export interface Repository {
	owner: string;
	repo: string;
}

/** A pull request by its repository and number. */
export interface PullRequest extends Repository {
	number: number;
}

/** A bad argument, such as a malformed PR or wait point, reported as a usage error. */
export class InputError extends Error {}

/** The forge or a claim refused the request, such as someone else holding the PR; distinct from a failure. */
export class Refusal extends Error {}

/** A check run or commit status on the head, as `quest status` prints it. */
export interface Check {
	name: string;
	required: boolean;
	/** The lowercased check-run conclusion or status, or commit-status state. */
	result: string;
	url: string | null;
}

/** A reviewer's latest submitted review. */
export interface Review {
	reviewer: string;
	/** approved, changes_requested, commented, or dismissed. */
	state: string;
	/** Whether the review was submitted against the current head. */
	current: boolean;
	commit: string | null;
	submittedAt: string;
	url: string;
}

/** A reaction on the PR or one of its reviews. */
export interface Reaction {
	content: string;
	actor: string;
	createdAt: string;
	/** The PR or review reacted to. */
	url: string;
}

/** An unresolved review thread. */
export interface Thread {
	id: string;
	path: string;
	/** The line on the current diff, or the original line once outdated. */
	line: number | null;
	outdated: boolean;
	lastAuthor: string;
	/** The thread's latest comment. */
	url: string;
}

/**
 * The head the `## Review` section holding `quest review`'s record names last, the latest reviewed one, which a
 * `quest review` status attests. `current` is the PR's head; `diff-identical` an earlier head whose diff from
 * the base (`git diff <base>...<sha>`) matches the head's, or that the head only merged the base since, each merge
 * the clean merge of its parents as `BaseMerges` checks it; `unknown` one the forge cannot compare, such as a diff too
 * large to render.
 */
export interface ReviewRecord {
	state: "current" | "diff-identical" | "stale" | "unknown";
	head: string;
}

/** One signal on a PR's head that holds it from landing until it is fixed or answered. */
export interface Signal {
	/** `finding`: on the head, from an online reviewer the base requires. `decision`: a marked comment newer than the head's commit. */
	kind: "finding" | "decision";
	/** The review, thread, or comment that raised it. */
	url: string;
	author: string;
	/** The finding's title or thread's first line, or the decision's first line. */
	text: string;
}

/** A hold label on a PR, and the event that took it when the timeline still shows it. */
export interface HoldFact {
	label: string;
	/** Null when the acquisition is older than the available timeline. */
	token: string | null;
	takenAt: string | null;
	age: string | null;
	/** The forge's verified event URL; the opaque token is not a browser anchor. */
	eventUrl: string | null;
}

/** A draft its starter still holds: one not handed back with `## Waiting`. */
export interface StarterHold {
	lastActive: string;
	age: string;
	url: string;
}

/** A quest the PR adds that another open PR also adds, at the same path or under the same title. */
export interface Duplicate {
	/** The quest file the PR adds. */
	path: string;
	/** The other open PR. */
	url: string;
	/** The quest file the other PR adds: `path` itself, or another path with the same title. */
	other: string;
}

/** Everything `quest status` reports about a PR. */
export interface Status {
	url: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	head: string;
	mergeable: string;
	mergeState: string;
	reviewDecision: string | null;
	/** `head` is the head it was enabled on, or null when that cannot be told. */
	autoMerge: { method: string; enabledBy: string; enabledAt: string; head: string | null } | null;
	mergeQueue: { state: string; position: number; enqueuedAt: string } | null;
	/**
	 * The latest exit from the merge queue, auto-merge, or `quest land`'s queue, and the reason for it;
	 * null once the PR is queued again.
	 */
	landingStopped: { reason: string; actor: string; at: string } | null;
	checks: { state: string | null; passed: number; failing: Check[]; pending: Check[] };
	/** Each reviewer's latest submitted review, oldest first. */
	reviews: Review[];
	/** The online reviewers whose rounds on the head have reached the point where the user decides. */
	checkpoints: { reviewer: string; round: number; url: string }[];
	/**
	 * Null when the `## Review` section holds no record `quest review` wrote or names no full SHA, or no writer's passing `quest review` status attests it.
	 * `localReview` is whether that status attests a local reviewer's round, false for a low head none ran on.
	 * `state` is `stale` for an open PR whose base's risk file at its tip is not the one the record names, since the
	 * tier that file set decided how much review the head got.
	 */
	reviewRecord: (ReviewRecord & { localReview: boolean }) | null;
	/**
	 * The head's risk tier as the `## Review` record names it, and the classifier's own tier, lower when a reviewer
	 * raised it; null when the record names none or does not count, as for `reviewRecord`. `state` is the review record's, which a line after it carries to a
	 * later head, else `current` when the record names the head and `stale` when not. `class` is the class, built
	 * in or the risk file's `## Automatic` one, the classifier found the change in, or null. A record whose risk lines do not parse is
	 * `malformed`, with why, which `quest merge` refuses.
	 */
	risk:
		| { tier: Tier; reason: string; classified: Tier; class: string | null; state: ReviewRecord["state"] }
		| { state: "malformed"; error: string }
		| null;
	reactions: Reaction[];
	/** Unresolved review threads, oldest first. */
	threads: Thread[];
	/** What holds the head from landing: unanswered findings on it from online reviewers the base requires, and newer maintainer decisions. */
	signals: Signal[];
	holds: HoldFact[];
	starterHold: StarterHold | null;
	/** Quests an open PR adds that another open PR also adds; none for a PR no longer open. */
	duplicates: Duplicate[];
}

/** A comment on a PR, or in one of its review threads. */
export interface Comment {
	author: string;
	body: string;
	createdAt: string;
	url: string;
}

/** A submitted review and its body; its inline comments are in its threads. */
export interface PostedReview {
	reviewer: string;
	/** approved, changes_requested, commented, or dismissed. */
	state: string;
	body: string;
	commit: string | null;
	submittedAt: string;
	url: string;
}

/** A review thread on a line of the diff, and its comments, oldest first. */
export interface ReviewThread {
	/** The ID `quest pr comment --thread` and `quest pr resolve` take. */
	id: string;
	path: string;
	/** The line on the current diff, or the original line once outdated. */
	line: number | null;
	outdated: boolean;
	resolved: boolean;
	comments: Comment[];
}

/** A PR's title, body, and discussion, as `quest pr view` prints them. */
export interface PullView {
	url: string;
	title: string;
	author: string;
	state: Status["state"];
	draft: boolean;
	body: string;
	/** Comments on the PR itself, oldest first. */
	comments: Comment[];
	/** Every submitted review, oldest first. */
	reviews: PostedReview[];
	/** Every review thread, resolved ones included, by its first comment. */
	threads: ReviewThread[];
}

/** An open PR, from any head repository, as the claim checks read it. */
export interface OpenPull {
	number: number;
	url: string;
	branch: string;
	/** The branch it merges into. */
	base: string;
	/** The head repository as `owner/repo`, or `null` once a fork is deleted. */
	head: string | null;
	/** The head commit, where the forge reports it. */
	sha?: string;
	draft: boolean;
	/** Epoch milliseconds. The earliest open PR on a branch holds the claim. */
	created: number;
	/** Epoch milliseconds of the last push, comment, or edit. */
	updated: number;
	/** Its body has a `## Waiting` section, so it waits on the maintainer. */
	handedBack: boolean;
	body: string;
}

/** An open PR and the paths it changes, as `quest pr list` prints them. */
export interface PullFiles {
	number: number;
	url: string;
	/** Every path the PR adds, changes, or removes; a rename lists its new path. */
	files: string[];
}

/** One harness, model, and effort that wrote a PR, with what its sessions cost at API list price in USD. */
export interface Writer {
	harness: string;
	/** Null for the cost no model was recorded for. */
	model: string | null;
	effort: string | null;
	/** The writer A/B arm its quest drew, if any. */
	arm: string | null;
	cost: number;
	/** False when the cost is a lower bound, as {@link ModelSpend}'s. */
	complete: boolean;
}

/**
 * A PR the forge updated since an instant, open, merged, or closed, as the record sender reads it. A hosted
 * repository has no forks, so its head repository is always the repository read.
 */
export interface UpdatedPull {
	number: number;
	/** The PR's page, which a session's recorded PR is matched by. */
	url: string;
	/** The head branch, as {@link OpenPull} names it. */
	branch: string;
	state: "open" | "closed" | "merged";
	/** Epoch milliseconds; the sender dates a breakage from its fix's creation. */
	created: number;
	/** Epoch milliseconds of the last push, comment, or edit. */
	updated: number;
	/** Epoch milliseconds a merged or closed PR ended, or null while it is open. */
	closed: number | null;
	body: string;
}

/** One page of {@link UpdatedPull}s, newest update first. */
export interface UpdatedPage {
	pulls: UpdatedPull[];
	/** The cursor for the following page, or null on the last. */
	next: string | null;
}

/** A held quest branch, and the open PR from it if there is one. */
export interface Claim {
	branch: string;
	/** The PR holding the claim: the earliest open one. */
	url: string | null;
	pull: OpenPull | null;
}

/** Which branches someone holds, and which landed branches a new claim replaces. */
export interface Holdings {
	/** Sorted by branch. */
	claims: Claim[];
	/**
	 * Branches in the head fork, or upstream without one, whose tip is the head of a merged PR, by
	 * that tip. Their work landed, so they hold nothing and a claim may replace them.
	 */
	landed: Map<string, string>;
}

/** A repository claim branches live in, and its `quest/*` branch tips when the caller already read them. */
export interface ClaimSource {
	repository: Repository;
	tips?: Map<string, string>;
}

/** Where claims live: the upstream repository, and the fork a contributor pushes claims to, if any. */
export interface ClaimSources {
	upstream: ClaimSource;
	/** Absent when claims are pushed upstream. */
	fork?: ClaimSource;
}

/** One line of `quest wait`'s output: when (a timestamp or commit SHA), what, who, and where. */
export interface WaitEvent {
	point: string;
	type: string;
	actor: string;
	url: string;
}

/** One poll of a PR's activity: what is new, in order, and where the next poll resumes. */
export interface WatchPoll {
	events: WaitEvent[];
	/** Opaque to the caller; `quest wait --since` takes it back. */
	cursor: string;
	/** The least time to the next poll the forge asks for, in milliseconds; 0 for none. */
	pollInterval: number;
}

/** A forge's answer, and the time of the newest webhook behind it, or null for a live read from the forge itself. */
export interface Answer<T> {
	value: T;
	asOf: string | null;
}

/** Polls of one PR's activity, each resuming where the last stopped. */
export interface Watch {
	/** Where a wait that times out now resumes: the latest cursor, else the point it started from, once known. */
	readonly resume: string | undefined;
	/** The activity since the last poll, or since the starting point on the first. */
	poll(): Promise<Answer<WatchPoll>>;
}

/** Where a watch starts, and when it gives up: epoch milliseconds, or Infinity. */
export interface WatchOptions {
	/** An ISO timestamp, a pushed SHA, or a cursor; the head's push time when absent. */
	since?: string;
	deadline: number;
	/** When the wait began, epoch milliseconds; where a backend resumes before it knows the head. Now when absent. */
	started?: number;
}

/** The reads quest makes of a forge. */
export interface Forge {
	/** What it is called in messages, such as `GitHub`. */
	readonly name: string;
	/** The person reading: whose own activity `quest wait` ignores, whichever credential serves the reads. */
	viewer(): Promise<string>;
	/** A PR's state, as `quest status` prints it. */
	status(pull: PullRequest): Promise<Answer<Status>>;
	/** Every open PR in `repository`, from any head repository. */
	pulls(repository: Repository): Promise<Answer<OpenPull[]>>;
	/** Every open PR in `repository` with the paths it changes, by number. */
	files(repository: Repository): Promise<Answer<PullFiles[]>>;
	/** Which of `branches` someone holds, as `quest start` decides it. */
	held(sources: ClaimSources, branches: string[]): Promise<Answer<Holdings>>;
	/** Polls of a PR's activity, starting from `options.since`. */
	watch(pull: PullRequest, options: WatchOptions): Watch;
	/** A PR's title, body, comments, reviews, and review threads. */
	view(pull: PullRequest): Promise<Answer<PullView>>;
}

/** A PR to open: `branch` in `head` (the repository itself, or a fork of it) onto `base` in `repository`. */
export interface Opening {
	repository: Repository;
	head: Repository;
	branch: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
}

/** A session's hold on a PR: what it is called, such as its label, and the opaque token naming it. */
export interface Hold {
	label: string;
	token: string;
}

/** How a merge method is named; a forge whose queue fast-forwards its base takes none. */
export type Method = "merge" | "squash" | "rebase";

/** What `quest merge` picks: the head the person saw, and how to land it where the forge offers a choice. */
export interface Pick {
	/** The full head SHA, which must still be the PR's head. */
	head: string;
	/** Null for the forge's default. */
	method: Method | null;
	/** Merge at once, past an ungated base's disabled auto-merge. */
	direct: boolean;
}

/**
 * The writes quest makes to a forge. A refusal the caller should report rather than retry, such as another session
 * holding the PR, is a `Refusal`.
 */
export interface ForgeWrites {
	/** Open a PR, returned as `pulls` lists it. A forge that keeps claims refuses a second open PR on a quest branch. */
	open(opening: Opening): Promise<OpenPull>;
	/** Close a PR without merging it. */
	close(pull: PullRequest): Promise<void>;
	/** Replace a PR's title, body, or both; null keeps one. */
	edit(pull: PullRequest, change: { title: string | null; body: string | null }): Promise<void>;
	/** Comment on a PR, or reply in the review thread `thread` names; returns the comment's URL. */
	comment(pull: PullRequest, comment: { body: string; thread: string | null }): Promise<string>;
	/** Resolve the review thread `thread` names, as `quest status` lists its ID. */
	resolve(pull: PullRequest, thread: string): Promise<void>;
	/**
	 * Take a PR for this session, or with `token` keep the hold it names. Refuses while the PR is merged or closed,
	 * another session holds it, or it is a draft its starter still holds.
	 */
	hold(pull: PullRequest, token: string | null): Promise<Hold>;
	/**
	 * Mark a draft ready for review. With `token`, as the session holding it: also drop its body's `## Waiting`
	 * section, keeping the hold it returns. Without one, it refuses while any session holds the PR.
	 */
	ready(pull: PullRequest, token: string | null): Promise<Hold | null>;
	/** Give up the hold `token` names; one already gone counts as given up. Works on a merged or closed PR too. */
	release(pull: PullRequest, token: string): Promise<Hold>;
	/** Queue the PR's head to land, refusing once it moved or while a session holds the PR. */
	pick(pull: PullRequest, pick: Pick): Promise<void>;
}

/** Each call Kixel Quest serves at `POST /forge/<call>`: the request it takes and the value it answers. */
export interface ForgeCalls {
	status: { request: { pull: PullRequest }; value: Status };
	pulls: { request: { repository: Repository }; value: OpenPull[] };
	/**
	 * The PRs updated at or after `since` (epoch milliseconds), merged and closed ones included, as `updatedPulls`
	 * reads GitHub's. `cursor` is null for the first page, then each page's `next`; a cursor never skips a PR when
	 * others move to the front. Kixel Quest sets the page size and serves it only for a repository it hosts.
	 */
	updated: { request: { repository: Repository; since: number; cursor: string | null }; value: UpdatedPage };
	files: { request: { repository: Repository }; value: PullFiles[] };
	held: { request: { sources: ClaimSources; branches: string[] }; value: Holdings };
	/** `from` is a `--since` point or a cursor; null starts at the head's push time. */
	watch: { request: { pull: PullRequest; from: string | null }; value: WatchPoll };
	view: { request: { pull: PullRequest }; value: PullView };
	/** Who wrote a PR, largest cost first. Only Kixel Quest answers it, as GitHub records no writer. */
	writers: { request: { pull: PullRequest }; value: Writer[] };
	open: { request: { opening: Opening }; value: OpenPull };
	close: { request: { pull: PullRequest }; value: null };
	edit: { request: { pull: PullRequest; title: string | null; body: string | null }; value: null };
	comment: { request: { pull: PullRequest; body: string; thread: string | null }; value: { url: string } };
	resolve: { request: { pull: PullRequest; thread: string }; value: null };
	hold: { request: { pull: PullRequest; token: string | null }; value: Hold };
	ready: { request: { pull: PullRequest; token: string | null }; value: Hold | null };
	release: { request: { pull: PullRequest; token: string }; value: Hold };
	/** Kixel Quest's queue fast-forwards the base, so a pick names only the head. */
	pick: { request: { pull: PullRequest; head: string }; value: null };
}

/** A call Kixel Quest serves. */
export type ForgeCall = keyof ForgeCalls;

/** The reads, as their paths name them. */
export const FORGE_READS = [
	"status",
	"pulls",
	"updated",
	"files",
	"held",
	"watch",
	"view",
	"writers",
] as const satisfies readonly ForgeCall[];

/** The writes, as their paths name them; Kixel Quest serves them only for a repository it hosts. */
export const FORGE_WRITES = [
	"open",
	"close",
	"edit",
	"comment",
	"resolve",
	"hold",
	"ready",
	"release",
	"pick",
] as const satisfies readonly ForgeCall[];

/** Every call, reads first. */
export const FORGE_CALLS: readonly ForgeCall[] = [...FORGE_READS, ...FORGE_WRITES];

/** `GET /forge`: the person a token names and the repositories, as lowercase `owner/repo`, read through Kixel Quest. */
export interface ForgeInfo {
	login: string;
	repositories: string[];
}

/** `value` as JSON: maps become objects. */
export function forgeJson(value: unknown): string {
	return JSON.stringify(value, (_, entry: unknown) => (entry instanceof Map ? Object.fromEntries(entry) : entry));
}

// Kixel Quest follows quest's main, so it and a repository's pinned client may each run a quest the other predates.
// Answers therefore drop fields the client does not know, and fill each field added since the wire's first release
// (quest v0.22.0), when absent, with a default that fails closed. A new value of a known field, such as another
// review state, still fails an older client, so carry new facts in new fields. Requests stay strict: a field the
// server does not know may carry intent, such as how to land a pick, that must not be dropped.

/** A `GET /forge` answer, dropping unknown fields and failing on any missing or ill-typed one. */
export function parseForgeInfo(value: unknown): ForgeInfo {
	return info(value, "info", false);
}

/** A request for `call`, failing on any missing, extra, or ill-typed field. */
export function parseForgeRequest<C extends ForgeCall>(call: C, value: unknown): ForgeCalls[C]["request"] {
	return REQUESTS[call](value, "request", true) as ForgeCalls[C]["request"];
}

/** An answer to `call`, dropping unknown fields, defaulting later ones, and failing on any other missing or ill-typed one. */
export function parseForgeAnswer<C extends ForgeCall>(call: C, value: unknown): Answer<ForgeCalls[C]["value"]> {
	return answer(VALUES[call])(value, "answer", false) as Answer<ForgeCalls[C]["value"]>;
}

type RiskStatus = NonNullable<Status["risk"]>;
type MalformedStatus = Extract<RiskStatus, { state: "malformed" }>;

/**
 * Parses untrusted JSON at a path named for its error, such as `answer.value.checks`; `strict` refuses unknown fields
 * rather than dropping them.
 */
type Parse<T> = (value: unknown, at: string, strict: boolean) => T;

const fail = (at: string, expected: string): never => {
	throw new Error(`malformed forge ${at}: expected ${expected}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const string: Parse<string> = (value, at) => (typeof value === "string" ? value : fail(at, "a string"));
const name: Parse<string> = (value, at) => (typeof value === "string" && value !== "" ? value : fail(at, "a name"));
const boolean: Parse<boolean> = (value, at) => (typeof value === "boolean" ? value : fail(at, "a boolean"));
const count: Parse<number> = (value, at) =>
	Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail(at, "a count");
const cost: Parse<number> = (value, at) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(at, "a cost");
const time: Parse<string> = (value, at) =>
	typeof value === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
	!Number.isNaN(Date.parse(value))
		? value
		: fail(at, "an ISO 8601 timestamp");
const oneOf =
	<T extends string>(options: readonly T[]): Parse<T> =>
	(value, at) =>
		options.includes(value as T) ? (value as T) : fail(at, `one of ${options.join(", ")}`);
const nullable =
	<T>(parse: Parse<T>): Parse<T | null> =>
	(value, at, strict) =>
		value === null ? null : parse(value, at, strict);
const list =
	<T>(parse: Parse<T>): Parse<T[]> =>
	(value, at, strict) =>
		Array.isArray(value)
			? value.map((entry, index) => parse(entry, `${at}[${index}]`, strict))
			: fail(at, "a list");
/** An object of these fields, rebuilt in their order so JSON output stays deterministic and drops unknown ones. */
const shape =
	<T>(fields: { [K in keyof T]-?: Parse<T[K]> }): Parse<T> =>
	(value, at, strict) => {
		if (!isRecord(value)) return fail(at, "an object");
		const extra = Object.keys(value).find((key) => !Object.hasOwn(fields, key));
		if (strict && extra !== undefined) fail(`${at}.${extra}`, "no such field");
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(fields) as (keyof T & string)[]) {
			const field = (fields as Record<string, Parse<unknown>>)[key]!;
			const absent = optional.get(field);
			if (Object.hasOwn(value, key)) out[key] = field(value[key], `${at}.${key}`, strict);
			else if (absent === undefined) fail(`${at}.${key}`, "a value");
			else if (absent.length > 0) out[key] = absent[0];
		}
		return out as T;
	};
/** Fields a shape may leave out, each with the value it takes when absent, if any. */
const optional = new WeakMap<Parse<unknown>, [] | [unknown]>();
/**
 * A field a shape may leave out: absent, or else `fallback`, for a field answers gained after the wire's first
 * release. The fallback is the value that permits the least, since an older server never decided it.
 */
function maybe<T>(parse: Parse<T>): Parse<T | undefined>;
function maybe<T extends boolean | string | null>(parse: Parse<T>, fallback: T): Parse<T>;
function maybe<T>(parse: Parse<T>, ...fallback: [] | [T]): Parse<T | undefined> {
	const parsed: Parse<T | undefined> = (value, at, strict) => parse(value, at, strict);
	optional.set(parsed, fallback);
	return parsed;
}
/** A JSON object of names to values, as a map. */
const mapOf =
	(key: Parse<string>, entry: Parse<string>): Parse<Map<string, string>> =>
	(value, at, strict) => {
		if (!isRecord(value)) return fail(at, "an object");
		return new Map(
			Object.entries(value).map(([k, v]) => [key(k, `${at} key`, strict), entry(v, `${at}.${k}`, strict)]),
		);
	};

const sha: Parse<string> = (value, at) =>
	typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : fail(at, "a full commit SHA");
const branch: Parse<string> = (value, at) =>
	typeof value === "string" && value.startsWith("quest/") ? value : fail(at, "a quest branch");
const repository = shape<Repository>({ owner: name, repo: name });
const pullRequest: Parse<PullRequest> = (value, at, strict) => {
	const pull = shape<PullRequest>({ owner: name, repo: name, number: count })(value, at, strict);
	return pull.number > 0 ? pull : fail(`${at}.number`, "a PR number");
};
const check = shape<Check>({ name: string, required: boolean, result: string, url: nullable(string) });
const reviewStates = ["current", "diff-identical", "stale", "unknown"] as const;
const tier = oneOf<Tier>(TIERS);

const statusFields = shape<Status>({
	url: string,
	state: oneOf(["open", "closed", "merged"]),
	draft: boolean,
	head: string,
	mergeable: string,
	mergeState: string,
	reviewDecision: nullable(string),
	autoMerge: nullable(
		shape<NonNullable<Status["autoMerge"]>>({
			method: string,
			enabledBy: string,
			enabledAt: time,
			head: nullable(string),
		}),
	),
	mergeQueue: nullable(
		shape<NonNullable<Status["mergeQueue"]>>({ state: string, position: count, enqueuedAt: time }),
	),
	landingStopped: nullable(shape<NonNullable<Status["landingStopped"]>>({ reason: string, actor: string, at: time })),
	checks: shape<Status["checks"]>({
		state: nullable(string),
		passed: count,
		failing: list(check),
		pending: list(check),
	}),
	reviews: list(
		shape<Review>({
			reviewer: string,
			state: string,
			current: boolean,
			commit: nullable(string),
			submittedAt: time,
			url: string,
		}),
	),
	checkpoints: list(shape<Status["checkpoints"][number]>({ reviewer: string, round: count, url: string })),
	reviewRecord: nullable(
		shape<NonNullable<Status["reviewRecord"]>>({ state: oneOf(reviewStates), head: string, localReview: boolean }),
	),
	risk: nullable((value, at, strict) =>
		isRecord(value) && value.state === "malformed"
			? shape<MalformedStatus>({ state: oneOf(["malformed"] as const), error: string })(value, at, strict)
			: shape<Exclude<RiskStatus, MalformedStatus>>({
					tier,
					reason: string,
					classified: tier,
					// A server older than #802 sends none: in no class, so no standing pick lands it.
					class: maybe(nullable(string), null),
					state: oneOf(reviewStates),
				})(value, at, strict),
	),
	reactions: list(shape<Reaction>({ content: string, actor: string, createdAt: time, url: string })),
	threads: list(
		shape<Thread>({
			id: string,
			path: string,
			line: nullable(count),
			outdated: boolean,
			lastAuthor: string,
			url: string,
		}),
	),
	signals: list(shape<Signal>({ kind: oneOf(["finding", "decision"]), url: string, author: string, text: string })),
	holds: list(
		shape<HoldFact>({
			label: string,
			token: nullable(string),
			takenAt: nullable(time),
			age: nullable(string),
			eventUrl: nullable(string),
		}),
	),
	starterHold: nullable(shape<StarterHold>({ lastActive: time, age: string, url: string })),
	duplicates: list(shape<Duplicate>({ path: string, url: string, other: string })),
});

/**
 * A server older than #868, which sends a review record without `localReview`, counted records no maintainer's
 * `quest review` status attests: that record, and the risk tier it names, count for no head. A malformed risk stays,
 * since `quest merge` refuses it.
 */
const status: Parse<Status> = (value, at, strict) =>
	statusFields(
		isRecord(value) && isRecord(value.reviewRecord) && !Object.hasOwn(value.reviewRecord, "localReview")
			? {
					...value,
					reviewRecord: null,
					risk: isRecord(value.risk) && value.risk.state === "malformed" ? value.risk : null,
				}
			: value,
		at,
		strict,
	);

const openPull = shape<OpenPull>({
	number: count,
	url: string,
	branch: name,
	base: name,
	head: nullable(name),
	sha: maybe(sha),
	draft: boolean,
	created: count,
	updated: count,
	handedBack: boolean,
	body: string,
});

const writer = shape<Writer>({
	harness: name,
	model: nullable(name),
	effort: nullable(name),
	arm: nullable(name),
	cost,
	complete: boolean,
});

const updatedPage = shape<UpdatedPage>({
	pulls: list(
		shape<UpdatedPull>({
			number: count,
			url: string,
			branch: name,
			state: oneOf(["open", "closed", "merged"]),
			created: count,
			updated: count,
			closed: nullable(count),
			body: string,
		}),
	),
	next: nullable(name),
});

const pullFiles = shape<PullFiles>({ number: count, url: string, files: list(name) });

const comment = shape<Comment>({ author: string, body: string, createdAt: time, url: string });

const pullView = shape<PullView>({
	url: string,
	title: string,
	author: string,
	state: oneOf(["open", "closed", "merged"]),
	draft: boolean,
	body: string,
	comments: list(comment),
	reviews: list(
		shape<PostedReview>({
			reviewer: string,
			state: string,
			body: string,
			commit: nullable(string),
			submittedAt: time,
			url: string,
		}),
	),
	threads: list(
		shape<ReviewThread>({
			id: string,
			path: string,
			line: nullable(count),
			outdated: boolean,
			resolved: boolean,
			comments: list(comment),
		}),
	),
});

const holdings = shape<Holdings>({
	claims: list(shape<Claim>({ branch, url: nullable(string), pull: nullable(openPull) })),
	landed: mapOf(branch, sha),
});

const source = shape<ClaimSource>({ repository, tips: maybe(mapOf(branch, sha)) });

const watchPoll = shape<WatchPoll>({
	events: list(shape<WaitEvent>({ point: name, type: name, actor: name, url: name })),
	cursor: name,
	pollInterval: count,
});

const info = shape<ForgeInfo>({
	login: name,
	repositories: list((value, at) =>
		typeof value === "string" && /^[a-z\d._-]+\/[a-z\d._-]+$/.test(value)
			? value
			: fail(at, "a lowercase owner/repo"),
	),
});

const hold = shape<Hold>({ label: name, token: name });
const none: Parse<null> = (value, at) => (value === null ? null : fail(at, "null"));

const REQUESTS: { [C in ForgeCall]: Parse<ForgeCalls[C]["request"]> } = {
	status: shape({ pull: pullRequest }),
	pulls: shape({ repository }),
	updated: shape({ repository, since: count, cursor: nullable(name) }),
	files: shape({ repository }),
	held: shape({
		sources: shape<ClaimSources>({ upstream: source, fork: maybe(source) }),
		branches: list(branch),
	}),
	watch: shape({ pull: pullRequest, from: nullable(name) }),
	view: shape({ pull: pullRequest }),
	writers: shape({ pull: pullRequest }),
	open: shape({
		opening: shape<Opening>({
			repository,
			head: repository,
			branch: name,
			base: name,
			title: name,
			body: string,
			draft: boolean,
		}),
	}),
	close: shape({ pull: pullRequest }),
	edit: shape({ pull: pullRequest, title: nullable(name), body: nullable(string) }),
	comment: shape({ pull: pullRequest, body: name, thread: nullable(name) }),
	resolve: shape({ pull: pullRequest, thread: name }),
	hold: shape({ pull: pullRequest, token: nullable(name) }),
	ready: shape({ pull: pullRequest, token: nullable(name) }),
	release: shape({ pull: pullRequest, token: name }),
	pick: shape({ pull: pullRequest, head: sha }),
};

const VALUES: { [C in ForgeCall]: Parse<ForgeCalls[C]["value"]> } = {
	status,
	pulls: list(openPull),
	updated: updatedPage,
	files: list(pullFiles),
	held: holdings,
	watch: watchPoll,
	view: pullView,
	writers: list(writer),
	open: openPull,
	close: none,
	edit: none,
	comment: shape({ url: name }),
	resolve: none,
	hold,
	ready: nullable(hold),
	release: hold,
	pick: none,
};

const answer = <T>(value: Parse<T>): Parse<Answer<T>> => shape<Answer<T>>({ value, asOf: nullable(time) });
