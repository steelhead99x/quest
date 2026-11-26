// Rank ready work without mistaking epic membership for downstream work.

import { handBackWaits } from "./claim";
import { type Doc, branchQuest, children, gates, permanent } from "./doc";
import { parked, ready, treeOrder } from "./ready";
import { ROOT, check, formatFinding } from "./rules";
import { type Wait, onMaintainer, waits } from "./waiting";

export interface RankedQuest {
	path: string;
	/** Distinct transitive dependents; other prerequisites may still remain. */
	dependents: number;
}

/**
 * How much finishing a quest matters: the milestone its subtree belongs to, and
 * its distinct transitive dependents. Validates the graph and document
 * structure; callers validate filesystem links.
 */
export interface Ranking {
	/** The rank of the root's child that holds `path`, lowest first; the root itself sorts last. */
	priority(path: string): number;
	/** Distinct transitive dependents of `path`, excluding epic membership, milestones, and parked work, including what an epic requiring it holds back. */
	impact(path: string): number;
}

/** Rank `docs`' quests by milestone, then downstream impact. */
export function ranking(docs: Doc[]): Ranking {
	const findings = check(docs, () => true);
	if (findings.length > 0) throw new Error(findings.map(formatFinding).join("\n"));

	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	const reverse = new Map<string, { path: string; structural: boolean }[]>();
	const depend = (target: string, path: string, structural: boolean) => {
		const dependents = reverse.get(target) ?? [];
		dependents.push({ path, structural });
		reverse.set(target, dependents);
	};
	for (const doc of docs) {
		// Parked work runs nothing, so it neither scores as a dependent nor
		// passes impact through.
		if (parked(docs, doc)) continue;
		// An epic's `Required` holds back everything under it, so each of those
		// quests depends on its blockers, milestones' included.
		for (const target of gates(docs, doc)) depend(target, doc.path, false);
		for (const child of children(docs, doc)) depend(child, doc.path, true);
	}

	// Assign the root's subtrees their priority before scoring. In particular,
	// many later-milestone dependents cannot promote a later candidate.
	const priority = new Map<string, number>();
	const assign = (path: string, rank: number) => {
		if (priority.has(path)) return;
		priority.set(path, rank);
		const doc = byPath.get(path);
		if (doc) for (const child of children(docs, doc)) assign(child, rank);
	};
	const root = byPath.get(ROOT);
	if (root) children(docs, root).forEach(assign);

	const impact = (path: string): number => {
		const visited = new Set([path]);
		const dependents = new Set<string>();
		const pending = [path];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			for (const edge of reverse.get(next) ?? []) {
				if (!edge.structural && !permanent(edge.path) && edge.path !== path) dependents.add(edge.path);
				// Membership does not score, but traversing it lets a real
				// dependency on an epic reach that epic's remaining work.
				if (visited.has(edge.path)) continue;
				visited.add(edge.path);
				pending.push(edge.path);
			}
		}
		return dependents.size;
	};

	return { priority: (path) => priority.get(path) ?? Infinity, impact };
}

/**
 * The quests ready on `today`, a `YYYY-MM-DD` date: milestone order, descending
 * downstream impact, then existing ready order. Readiness and impact are local
 * facts, independent of claims or outside conditions.
 */
export function unblocked(docs: Doc[], today: string): RankedQuest[] {
	const rank = ranking(docs);
	return ready(docs, today)
		.map((path) => ({ path, dependents: rank.impact(path) }))
		.sort((a, b) => rank.priority(a.path) - rank.priority(b.path) || b.dependents - a.dependents);
}

/** An open draft PR, as `quest waiting` reads its hand-back. */
export interface Draft {
	url: string;
	/** Its head branch, which names the quest it carries when it is a claim. */
	branch: string;
	body: string;
}

/** A quest with a `## Waiting` section, or a draft PR handed back, as `quest waiting` lists it. */
export interface WaitingQuest {
	/** The quest, or the one the draft carries; `null` for a draft that carries none. */
	path: string | null;
	/** The draft's URL, or `null` for a quest's own section. */
	pr: string | null;
	/** Distinct transitive dependents, as `quest unblocked` counts them. */
	dependents: number;
	/** No `Required` entry, `Parked` item, or future `Scheduled` date remains on it or an epic above it, so clearing its waits lets the work go on. */
	ready: boolean;
	waits: Wait[];
}

/** What `waiting` reads beyond the tree, and which items it keeps. */
export interface WaitingOptions {
	/** The open drafts to read hand-backs from. */
	drafts?: Draft[];
	/** Keep only the maintainer's items. */
	maintainer?: boolean;
	/** `false` drops `Maintainer (PC):` items, for a session away from the maintainer's computers. */
	pc?: boolean;
}

/**
 * Every quest with a `## Waiting` section, unless it or an epic above it is
 * parked, and every draft in `drafts` handed back with one, holding the items
 * `options` keeps: those waiting on the maintainer first, then milestone order,
 * descending downstream impact, ready before blocked, then tree order, with
 * drafts after quests in the order given. A draft ranks as the quest its branch
 * carries, or last when it carries none. Readiness is as of `today`, a
 * `YYYY-MM-DD` date. Validates the tree first, as `unblocked` does.
 */
export function waiting(docs: Doc[], today: string, options: WaitingOptions = {}): WaitingQuest[] {
	const { drafts = [], maintainer: only = false, pc = true } = options;
	const kept = (wait: Wait) => (!only || onMaintainer(wait)) && (pc || wait.kind === "decision" || !wait.pc);
	const rank = ranking(docs);
	const startable = new Set(ready(docs, today));
	const maintainer = (quest: WaitingQuest) => (quest.waits.some(onMaintainer) ? 0 : 1);
	const priority = (quest: WaitingQuest) => (quest.path === null ? Infinity : rank.priority(quest.path));
	const byPath = new Map(docs.map((doc) => [doc.path, doc]));
	const entry = (path: string | null, pr: string | null, found: Wait[]): WaitingQuest => ({
		path,
		pr,
		dependents: path === null ? 0 : rank.impact(path),
		ready: path === null || startable.has(path),
		waits: found.filter(kept),
	});
	// Nobody acts on parked work's waits until it is unparked. A draft for it is
	// still listed: an open PR is live work whatever its quest says.
	const quests = treeOrder(docs)
		.map((path) => byPath.get(path)!)
		.filter((doc) => !parked(docs, doc))
		.map((doc) => entry(doc.path, null, waits(doc)));
	const pulls = drafts.map((draft) => {
		const quest = branchQuest(draft.branch);
		return entry(byPath.has(quest) ? quest : null, draft.url, handBackWaits(draft.body));
	});
	// The sort is stable, so ties keep tree order, as they do in `unblocked`.
	return [...quests, ...pulls]
		.filter((quest) => quest.waits.length > 0)
		.sort(
			(a, b) =>
				maintainer(a) - maintainer(b) ||
				priority(a) - priority(b) ||
				b.dependents - a.dependents ||
				Number(b.ready) - Number(a.ready),
		);
}
