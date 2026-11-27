// How a quest's PR and branch say whose move it is. A draft is its starter's
// claim until its body hands it back with a `## Waiting` section, and a branch
// whose work merged holds nothing (the guide's Execution section).

import type { RootContent } from "mdast";

import { itemParts, markdown, rendered } from "./doc";
import { MAINTAINER, type Wait, type WaitProblem, readDraftWait } from "./waiting";

// The heading that hands a draft back to the maintainer.
const HAND_BACK = /^waiting$/i;

// The checkbox GitHub renders at the start of a task-list item.
const TASK = /^\[[ xX]\] /;

/** One hand-back section of a PR body. */
interface HandBack {
	/** The start of its heading's line. */
	start: number;
	/** The next level-1 or level-2 heading's line, or the body's end. */
	end: number;
	/** The top-level nodes after its heading. */
	nodes: RootContent[];
}

/**
 * Each hand-back section in a PR body: from the start of its `## Waiting`
 * heading's line to the next level-1 or level-2 heading. Only top-level
 * headings count, as Markdown parses them, so an example inside a code fence,
 * a list, or a quote is text.
 */
function handBacks(body: string): HandBack[] {
	const sections: HandBack[] = [];
	let open: Omit<HandBack, "end"> | undefined;
	for (const node of markdown(body).children) {
		if (node.type !== "heading" || node.depth > 2) {
			open?.nodes.push(node);
			continue;
		}
		const offset = node.position?.start.offset ?? 0;
		const line = body.lastIndexOf("\n", offset - 1) + 1;
		if (open !== undefined) sections.push({ ...open, end: line });
		const title = rendered(node).trim();
		open = node.depth === 2 && HAND_BACK.test(title) ? { start: line, nodes: [] } : undefined;
	}
	if (open !== undefined) sections.push({ ...open, end: body.length });
	return sections;
}

/** Whether a PR body hands its draft back to the maintainer; only the heading's presence matters. */
export function handedBack(body: string): boolean {
	return handBacks(body).length > 0;
}

/** One hand-back item: the wait it reads as, and any choice list problem that made it prose. */
interface HandBackItem {
	wait: Wait;
	problems: WaitProblem[];
}

function handBackItems(body: string): HandBackItem[] {
	const found: HandBackItem[] = [];
	const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
	for (const { start, nodes } of handBacks(body)) {
		const items = nodes
			.filter((node) => node.type === "list")
			.flatMap((list) => list.children)
			.map((item): HandBackItem => {
				// GitHub renders a leading `[ ]` or `[x]` as a task-list checkbox, so the item's text follows it.
				const parts = itemParts(item);
				if (typeof parts[0] === "string") parts[0] = parts[0].replace(TASK, "");
				return readDraftWait({ line: item.position?.start.line ?? 1, parts });
			});
		if (items.length === 0)
			items.push({
				wait: {
					line: body.slice(0, start).split("\n").length,
					party: MAINTAINER,
					kind: "prose",
					text:
						collapse(nodes.map(rendered).join(" ")) ||
						"the draft hands back without saying what it waits on",
				},
				problems: [],
			});
		found.push(...items);
	}
	return found;
}

/**
 * What a PR body hands back: one wait per item of each hand-back section's
 * top-level lists, with lines counted in `body`. A draft hands back to the
 * maintainer, so an item that names no party is theirs. A section without
 * items still hands the draft back, so it reads as one maintainer item
 * holding its prose. An item with a malformed choice list reads as prose,
 * since nothing checks a PR body; `handBackProblems` names what broke it.
 */
export function handBackWaits(body: string): Wait[] {
	return handBackItems(body).map((item) => item.wait);
}

/** The malformed choice lists in a PR body's hand-back, which `quest waiting` warns about. */
export function handBackProblems(body: string): WaitProblem[] {
	return handBackItems(body).flatMap((item) => item.problems);
}

/** `body` without its hand-back sections, which `quest ready` drops as it marks a draft ready. */
export function withoutHandBack(body: string): string {
	let kept = "";
	let from = 0;
	for (const { start, end } of handBacks(body)) {
		kept += body.slice(from, start);
		from = end;
	}
	return (kept + body.slice(from)).trimEnd();
}

/** A closed PR from a quest's branch: the commit it ended at, and whether it merged. */
export interface ClosedPull {
	head: string;
	merged: boolean;
}

/**
 * The PR that landed a quest branch at `tip`: one from it that merged with
 * `tip` as its head, so the branch holds no claim. One whose PR closed unmerged
 * still holds its quest, since that work may be wanted back, and so does one
 * with commits pushed after its merge.
 */
export function landed<P extends ClosedPull>(tip: string, pulls: Iterable<P>): P | undefined {
	for (const pull of pulls) if (pull.merged && pull.head === tip) return pull;
	return undefined;
}
