// The audit pack: recurring audits quest ships, which a repository runs
// through stubs naming them in an `## Audit` section. The definitions are
// assets the CLI prints; the core knows only their names and stub titles, so
// `quest check` and `quest init` agree on them without the assets.

import { type Doc, type Entry, entries } from "./doc";

/** One shipped audit: the name a stub's `## Audit` section holds, and the title a planted stub opens with. */
export interface Audit {
	name: string;
	title: string;
}

/** Every audit quest ships, in the order `quest audit` lists and `quest init` plants them. */
export const AUDITS: readonly Audit[] = [
	{ name: "tree", title: "[M] Audit the quest tree" },
	{ name: "deps", title: "[M] Audit dependencies" },
	{ name: "code", title: "[L] Audit the code" },
	{ name: "cost", title: "[L] Audit build and CI cost" },
	{ name: "docs", title: "[M] Audit the docs" },
	{ name: "tests", title: "[M] Audit test coverage" },
	{ name: "instructions", title: "[XL] Audit agent instructions" },
];

/** The section naming the audit a quest runs. */
export const AUDIT = "Audit";

/** The root README's section listing the audits this repository does not run. */
export const SKIPPED = "Skipped audits";

/** The audit an `## Audit` item names, or null when it names none quest ships. */
export function auditOf(entry: Entry): string | null {
	return AUDITS.some((audit) => audit.name === entry.text) ? entry.text : null;
}

/** The audit a `## Skipped audits` item names, as `deps` or `deps - why`, or null when it names none quest ships. */
export function skippedOf(entry: Entry): string | null {
	const name = /^(\S+)(?: - .+)?$/.exec(entry.text)?.[1];
	return AUDITS.some((audit) => audit.name === name) ? name! : null;
}

/** The audits `docs` already run, by an `## Audit` section, or skip, in the root README. */
export function covered(docs: readonly Doc[], root: string): Set<string> {
	const named = docs.flatMap((doc) => entries(doc, AUDIT).map(auditOf));
	const skipped = docs.filter((doc) => doc.path === root).flatMap((doc) => entries(doc, SKIPPED).map(skippedOf));
	return new Set([...named, ...skipped].filter((name): name is string => name !== null));
}
