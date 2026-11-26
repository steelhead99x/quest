// What a quest waits on outside its own work: the `## Waiting` section, where
// each top-level item opens with who acts, `Maintainer:`, `Maintainer (action):`,
// `Maintainer (PC):`, or an outside party such as `moq-dev/moq:`. A plain
// `Maintainer:` item with a nested choice list, one bullet marked
// `(Recommended)`, is a decision a client can render as buttons. The same
// heading hands a draft PR back (claim.ts).

import type { Bullet, Doc, Entry, NestedList, Part } from "./doc";
import { entries } from "./doc";

/** The section a quest names what it waits on in. */
export const WAITING = "Waiting";

/** The party that names the maintainer: a decision or action only they can take. */
export const MAINTAINER = "Maintainer";

/** One item of a `## Waiting` section, by the kind of answer it needs. */
export type Wait = Prose | Decision | Action;

interface Item {
	/** 1-based source line, for findings. */
	line: number;
	/** Who acts, as the item opens: `Maintainer`, or an outside party. */
	party: string;
	/** The condition, and how to check or advance it; a decision's leaves out its choice list. */
	text: string;
}

/** An item read as written: an outside party's condition, or a maintainer's item without a marked choice list. */
export interface Prose extends Item {
	kind: "prose";
	/** Set on a `Maintainer (PC):` item read as prose for its malformed choice list, so `--no-pc` still skips it. */
	pc?: true;
}

/** The maintainer's choice among the options its choice list gives. */
export interface Decision extends Item {
	kind: "decision";
	choices: Choice[];
}

/** A step only the maintainer can take, opened as `Maintainer (action):` or `Maintainer (PC):`. */
export interface Action extends Item {
	kind: "action";
	/** A step they can take only at one of their computers, opened as `Maintainer (PC):`. */
	pc: boolean;
}

/** One option of a decision, written `label` or `label - description`. */
export interface Choice {
	label: string;
	description: string | null;
	/** The one choice marked `(Recommended)`. */
	recommended: boolean;
}

/** A malformed choice list, which `quest check` rejects and a draft's hand-back reads as prose. */
export interface WaitProblem {
	line: number;
	message: string;
}

/** An item as `readWait` reads it: `null` when it does not open with its party. */
export interface ReadWait {
	wait: Wait | null;
	problems: WaitProblem[];
}

// A party is a short label before the first colon: `Maintainer`, `moq-dev/moq`,
// `Akamai sales`. A longer run reads as a sentence that happens to hold a colon.
const PARTY = /^([^:\s][^:]{0,39}):(?:\s+(\S[\s\S]*))?$/;

// The maintainer with a qualifier; only `(action)` and `(PC)` are ones, so a typo such as
// `(local)` fails `quest check` instead of reading as an outside party.
const QUALIFIED = /^maintainer\s*\((.*)\)$/i;

const MARKER = /\(recommended\)/i;
const MARKED_LABEL = /\s*\(recommended\)$/i;

// A choice's label runs to its first ` - `; the rest describes it.
const SEPARATOR = " - ";

function render(parts: Part[]): string {
	return parts
		.map((part) => (typeof part === "string" ? part : part.bullets.map((bullet) => bullet.text).join(" ")))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

// A bullet's label and description: the label comes from its own paragraph, so a ` - ` in nested
// detail never cuts it, and the description runs on through that detail.
function choiceText(bullet: Bullet): { label: string; description: string | null } {
	const at = bullet.lead.indexOf(SEPARATOR);
	const label = at < 0 ? bullet.lead : bullet.lead.slice(0, at);
	const description = bullet.text.slice(at < 0 ? bullet.lead.length : at + SEPARATOR.length).trim();
	return { label: label.trim(), description: description || null };
}

// Whether a bullet's label ends with the marker, the only way an item other than a decision can mark one.
function endsLabel(bullet: Bullet): boolean {
	return MARKED_LABEL.test(choiceText(bullet).label);
}

// A marked list's choices, or the problems that make it no choice list.
function choicesOf(list: NestedList): { choices: Choice[]; problems: WaitProblem[] } {
	const problems: WaitProblem[] = [];
	const seen = new Set<string>();
	const choices = list.bullets.map((bullet): Choice => {
		const { label: marked, description } = choiceText(bullet);
		const recommended = MARKED_LABEL.test(marked);
		const label = marked.replace(MARKED_LABEL, "").trim();
		const marks = bullet.text.split(MARKER).length - 1;
		if (marks > (recommended ? 1 : 0))
			problems.push({
				line: bullet.line,
				message: "'(Recommended)' must end its choice's label, as 'label (Recommended) - description'",
			});
		if (label === "") problems.push({ line: bullet.line, message: "a choice needs a label" });
		else if (seen.has(label.toLowerCase()))
			problems.push({ line: bullet.line, message: `choice '${label}' is listed twice` });
		seen.add(label.toLowerCase());
		return { label, description, recommended };
	});
	if (choices.length < 2) problems.push({ line: list.line, message: "a choice list needs at least two choices" });
	if (choices.filter((choice) => choice.recommended).length !== 1)
		problems.push({ line: list.line, message: "a choice list marks exactly one choice '(Recommended)'" });
	return { choices, problems };
}

// The nested lists a marker makes choice lists: under a decision a marker anywhere, so a misplaced one is
// caught; elsewhere only one ending a label, so a detail bullet such as `Review logs (recommended) first` stays prose.
function markedLists(parts: Part[], decision: boolean): NestedList[] {
	return parts.filter(
		(part): part is NestedList =>
			typeof part !== "string" &&
			part.bullets.some((bullet) => (decision ? MARKER.test(bullet.text) : endsLabel(bullet))),
	);
}

function misplaced(lists: NestedList[]): WaitProblem[] {
	return lists.map((list) => ({
		line: list.line,
		message: `a choice list belongs only under a plain '${MAINTAINER}:' decision`,
	}));
}

/**
 * Read one quest's `## Waiting` item: its party, and the kind of answer it
 * needs, or `null` when it does not open with its party. An item with a
 * malformed choice list reads as prose beside its problems.
 */
export function readWait(entry: Pick<Entry, "line" | "parts">): ReadWait {
	return read(entry, false);
}

/**
 * Read one item of a draft's hand-back, which `quest check` never sees: an
 * item that names no party, or an unknown qualifier, is the maintainer's
 * prose, beside a problem when the writer evidently meant otherwise.
 */
export function readDraftWait(entry: Pick<Entry, "line" | "parts">): { wait: Wait; problems: WaitProblem[] } {
	const { wait, problems } = read(entry, true);
	return {
		wait: wait ?? { line: entry.line, party: MAINTAINER, kind: "prose", text: render(entry.parts) },
		problems,
	};
}

function read(entry: Pick<Entry, "line" | "parts">, draft: boolean): ReadWait {
	const [lead, ...rest] = entry.parts;
	// Only the item's own opening names its party, so a nested `label: description` choice never does.
	const match = typeof lead === "string" ? PARTY.exec(lead.replace(/\s+/g, " ").trim()) : null;
	const text = render([match?.[2] ?? "", ...rest]);
	if (!match || text === "") {
		// A marked list under an item without a party may be a checklist, so it stays prose until `Maintainer:` opens it.
		const problems = markedLists(entry.parts, false).map((list) => ({
			line: list.line,
			message: `a choice list needs '${MAINTAINER}:' before its question to become a decision`,
		}));
		return { wait: null, problems: draft ? problems : [] };
	}
	const party = match[1].trim();
	const qualified = QUALIFIED.exec(party);
	const qualifier = qualified?.[1].trim().toLowerCase();
	if (qualifier !== undefined && qualifier !== "pc" && qualifier !== "action") {
		const problem = {
			line: entry.line,
			message: `'${party}' qualifies the maintainer with neither '(action)' nor '(PC)'`,
		};
		return { wait: null, problems: draft ? [problem] : [] };
	}
	const plain = qualified === null && party.toLowerCase() === MAINTAINER.toLowerCase();
	const base = { line: entry.line, party: qualified ? MAINTAINER : party, text };
	const fallback: Wait =
		qualifier === undefined ? { ...base, kind: "prose" } : { ...base, kind: "action", pc: qualifier === "pc" };
	// A malformed choice list is an unsettled question, never a step to mark done.
	const broken: Wait = { ...base, kind: "prose" };

	// Only a marker makes a nested list a choice list, so checklists and detail lists stay prose.
	const marked = markedLists(entry.parts, plain);
	if (marked.length === 0) return { wait: fallback, problems: [] };
	// A choice list under a qualified party is an unsettled question too, so it reads as prose, keeping a
	// `(PC)` qualifier for `--no-pc` to drop.
	if (!plain) return { wait: qualifier === "pc" ? { ...broken, pc: true } : broken, problems: misplaced(marked) };
	const [list, ...extra] = marked;
	const { choices, problems } = choicesOf(list);
	for (const other of extra)
		problems.push({
			line: other.line,
			message: "a decision holds one choice list; split the others into items of their own",
		});
	if (problems.length > 0) return { wait: broken, problems };
	const question = render([match[2] ?? "", ...rest.filter((part) => part !== list)]);
	if (question === "")
		return {
			wait: broken,
			problems: [{ line: entry.line, message: "a decision needs its question before its choices" }],
		};
	return { wait: { ...base, kind: "decision", text: question, choices }, problems: [] };
}

/** `doc`'s waits, in source order; an item without a party is left to `quest check`. */
export function waits(doc: Doc): Wait[] {
	return entries(doc, WAITING)
		.map((entry) => readWait(entry).wait)
		.filter((wait): wait is Wait => wait !== null);
}

/** Whether `wait` is the maintainer's to settle. */
export function onMaintainer(wait: Wait): boolean {
	return wait.party.toLowerCase() === MAINTAINER.toLowerCase();
}

/** `wait` as one line: its party, qualifier, text, and a decision's choices. */
export function waitLine(wait: Wait): string {
	const qualifier = wait.kind !== "decision" && wait.pc ? " (PC)" : wait.kind === "action" ? " (action)" : "";
	const choices =
		wait.kind === "decision"
			? ` Choices: ${wait.choices
					.map(
						(choice) =>
							`${choice.label}${choice.recommended ? " (Recommended)" : ""}${choice.description === null ? "" : ` - ${choice.description}`}`,
					)
					.join("; ")}`
			: "";
	return `${wait.party}${qualifier}: ${wait.text}${choices}`;
}
