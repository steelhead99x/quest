// What a board shows, read from a tree with the CLI's own core, so its order and
// readiness agree with `quest unblocked` and `quest waiting`.

import {
	type Blocker,
	blockers,
	check,
	comparePaths,
	type Doc,
	type Finding,
	formatFinding,
	handedBack,
	isEpic,
	parse,
	permanent,
	questBranch,
	ROOT,
	type RankedQuest,
	ready,
	size,
	unblocked,
	type WaitingQuest,
	waiting,
} from "../../../src/core/index.ts";
import type { Size, Status } from "../layout.tsx";
import type { Pull, Tree } from "./load.ts";

/** A quest on the board. */
export interface Quest {
	path: string;
	title: string;
	size: Size | null;
	status: Status;
	/** The open PR that holds its claim, the earliest on its branch. */
	pull: Pull | null;
	/** A draft whose body hands it back with `## Waiting`. */
	handedBack: boolean;
}

/** Counts of quests by state. */
export type Counts = Record<Status, number>;

/** A milestone's own counts. */
export interface MilestoneRow {
	path: string;
	title: string;
	counts: Counts;
	total: number;
}

/** Everything a board page shows. */
export interface Board {
	tree: Tree;
	/** The timezone whose calendar day decides Scheduled dates. */
	zone: string;
	docs: Doc[];
	/** Structural mistakes `quest check` would report; when any, nothing is ranked. */
	findings: string[];
	quests: Map<string, Quest>;
	counts: Counts;
	sizes: Record<Size | "unsized", number>;
	milestones: MilestoneRow[];
	/** Ready, unclaimed quests in `quest unblocked`'s order. */
	ranked: (RankedQuest & { quest: Quest })[];
	/** `quest waiting`'s list, the maintainer's first. */
	waiting: WaitingQuest[];
}

const SIZE_ORDER: (Size | "unsized")[] = ["XS", "S", "M", "L", "XL", "unsized"];

/** A quest title without its size tag. */
export function name(doc: Doc): string {
	return (doc.title?.text ?? doc.path).replace(/^\[(XS|S|M|L|XL)\]\s+/, "");
}

/**
 * The YYYY-MM-DD of `now` in `zone`, for Scheduled dates. The CLI reads them on
 * its machine's calendar; the site has no machine, so the deploy names the
 * zone its maintainer plans in (SCHEDULE_TIMEZONE).
 */
export function today(now: number, zone: string): string {
	// en-CA formats dates as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(now));
}

/** The claim each quest branch carries: the earliest open PR on it, or the bare branch. */
function claims(tree: Tree): Map<string, Pull | null> {
	const out = new Map<string, Pull | null>();
	for (const branch of tree.branches) out.set(branch, null);
	// Pulls arrive oldest first, so the first one on a branch holds its claim.
	for (const pull of tree.pulls) if (!out.get(pull.branch)) out.set(pull.branch, pull);
	return out;
}

/** Read a tree into a board as of `now`. */
export function board(tree: Tree, now: number, zone: string): Board {
	const date = today(now, zone);
	const docs = [...tree.documents]
		.sort((a, b) => comparePaths(a.path, b.path))
		.map(({ path, content }) => parse(path, content));
	// Links to files outside the tree cannot be checked from here; the CLI checks them.
	const found: Finding[] = check(docs, () => true);
	const findings = found.map(formatFinding);
	const open = new Set(ready(docs, date));
	const claimed = claims(tree);

	const quests = new Map<string, Quest>();
	for (const doc of docs) {
		if (permanent(doc.path) || doc.path === ROOT || isEpic(docs, doc)) continue;
		const branch = questBranch(doc.path);
		const held = claimed.has(branch);
		const pull = claimed.get(branch) ?? null;
		const back = pull !== null && pull.draft && handedBack(pull.body);
		const status: Status =
			pull && !pull.draft ? "review" : held ? "claimed" : open.has(doc.path) ? "ready" : "blocked";
		quests.set(doc.path, { path: doc.path, title: name(doc), size: size(doc), status, pull, handedBack: back });
	}

	const counts: Counts = { ready: 0, blocked: 0, claimed: 0, review: 0 };
	const sizes = Object.fromEntries(SIZE_ORDER.map((s) => [s, 0])) as Board["sizes"];
	for (const q of quests.values()) {
		counts[q.status]++;
		sizes[q.size ?? "unsized"]++;
	}

	const milestones = docs
		.filter((d) => permanent(d.path) && d.path !== ROOT)
		.map((d): MilestoneRow => {
			const dir = d.path.replace(/README\.md$/, "");
			const mine = [...quests.values()].filter((q) => q.path.startsWith(dir));
			const c: Counts = { ready: 0, blocked: 0, claimed: 0, review: 0 };
			for (const q of mine) c[q.status]++;
			return { path: d.path, title: name(d), counts: c, total: mine.length };
		});

	let ranked: Board["ranked"] = [];
	let waits: WaitingQuest[] = [];
	if (findings.length === 0) {
		ranked = unblocked(docs, date).flatMap((r) => {
			const quest = quests.get(r.path);
			return quest && quest.status === "ready" ? [{ ...r, quest }] : [];
		});
		const drafts = tree.pulls.filter((p) => p.draft).map((p) => ({ url: p.url, branch: p.branch, body: p.body }));
		waits = waiting(docs, date, drafts);
	}

	return { tree, zone, docs, findings, quests, counts, sizes, milestones, ranked, waiting: waits };
}

/** What holds back one quest, as `quest unblocked <path>` prints it. */
export function holdsBack(b: Board, path: string, now: number, zone: string): Blocker[] {
	const doc = b.docs.find((d) => d.path === path);
	return doc ? blockers(b.docs, doc, today(now, zone)) : [];
}

/** The document for a page path, which is the quest's branch: `quest/m0/foo` or `quest/m0/epic/README`. */
export function lookup(b: Board, page: string): Doc | null {
	return b.docs.find((d) => questBranch(d.path) === page) ?? null;
}

/** The milestone and epics above a document, outermost first. */
export function parents(b: Board, path: string): Doc[] {
	const out: Doc[] = [];
	const parts = path.split("/");
	for (let i = 2; i < parts.length; i++) {
		const readme = [...parts.slice(0, i), "README.md"].join("/");
		if (readme === path) break;
		const doc = b.docs.find((d) => d.path === readme);
		if (doc) out.push(doc);
	}
	return out;
}
