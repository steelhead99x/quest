// The harnesses, models, and efforts `quest` runs for each size, the same for
// every repository; a repository's AGENTS.md may override them in prose, which
// the session following it passes as flags. The model check
// (quest/m1/model-check.md) audits these lists each milestone.
import { createHash } from "node:crypto";
<<<<<<< HEAD
import { type Doc, SIZES, type Size, onMaintainer, size, waits } from "../core";

/** The agent CLIs `quest` runs. */
export const HARNESSES = ["claude", "codex"] as const;
/** One of HARNESSES. */
export type HarnessName = (typeof HARNESSES)[number];
=======
import { type Doc, SIZES, type Size, TIERS, type Tier, onMaintainer, size, waits } from "../core";
import type { HarnessName } from "./agent";
>>>>>>> upstream/main

/** One harness running one model at one effort. */
export interface Model {
	harness: HarnessName;
	model: string;
	effort: string;
	/** The model Claude Code's advisor tool consults, as `claude --advisor` names it; no other harness runs one. */
	advisor?: string;
}

/** The size of a PR with neither a quest nor `--size`. */
export const DEFAULT_SIZE: Size = "M";

const sol = (effort: string): Model => ({ harness: "codex", model: "gpt-6.2-sol", effort });
const opus = (effort: string): Model => ({ harness: "claude", model: "claude-opus-5-5", effort });
const sonnet = (effort: string): Model => ({ harness: "claude", model: "claude-sonnet-5-5", effort });
const advised = (entry: Model, advisor: string): Model => ({ ...entry, advisor });

/**
 * Each size's writers, ranked: a spawn starts the quest on the first that can
 * run, falling through only while nothing is written, since the model that
 * writes a PR runs all its iterates. Only Claude writes; a quest whose writers are all at their usage limit
 * waits for one rather than starting on another vendor. XS runs Sonnet rather
 * than the cheaper Haiku, whose surcharge past 100k input tokens leads users
 * to cap its compaction window there, barely above an agent's fixed load of
 * prompt, context, and skill. No size runs Opus at low, which misses too much.
 * XL runs Opus at xhigh rather than Fable, which costs several times as much
 * and draws on a limit a subscription caps at half the weekly one.
 */
export const WRITERS: Record<Size, readonly Model[]> = {
	XS: [sonnet("high")],
	S: [opus("medium")],
	M: [opus("high")],
	L: [opus("high")],
	XL: [opus("xhigh")],
};

/**
 * Whether model `reviewer` is too weak to review what model `writer` wrote: only Sonnet is, of any other model's
 * work. A model may review its own work, in a session of its own.
 */
export const weaker = (reviewer: string, writer: string): boolean =>
	reviewer !== writer && reviewer === "claude-sonnet-5-5";

/**
 * Whether an entry runs model `model` or a {@link weaker} one, as `--exclude-model` avoids. `model` is a listed
 * model's ID, so callers pass a record's or flag's spelling through `canonicalModel` first.
 */
export const unfit =
	(model: string) =>
	(entry: Model): boolean =>
		entry.model === model || weaker(entry.model, model);

/** One rung of the `(size + risk)` reviewer ladder: how many seats run at once, and the ranked reviewers for it. */
export interface ReviewRung {
	/** How many gating reviewers run at once (1 on rungs 0–2; 2 on rungs 3–6 until Neon joins rungs 5–6). */
	seats: 1 | 2;
	/** Ordered reviewers: on a 1-seat rung, the pick with its fallback; on a 2-seat rung, both required seats. */
	reviewers: readonly Model[];
}

/**
 * The 7-rung `(size + risk)` reviewer ladder (`SIZES.indexOf(size) + TIERS.indexOf(tier)` → `0..6`):
 * every `low` head runs Sol (no unreviewed tier), `sol("low")` is retired, rungs `0..2` run 1 seat (falling from Sol
 * to Opus when Sol cannot run), and rungs `3..6` run both Sol and Opus. No rung names Fable, whose xhigh reviews
 * measured at ten times Sol xhigh's cost per PR for half its high findings, or Astra, which no review showed finding
 * what these two missed.
 */
export const REVIEW_RUNGS: readonly ReviewRung[] = [
	// 0: XS low
	{ seats: 1, reviewers: [sol("medium"), opus("medium")] },
	// 1: XS medium, S low
	{ seats: 1, reviewers: [sol("high"), opus("medium")] },
	// 2: XS high, S medium, M low
	{ seats: 1, reviewers: [sol("xhigh"), opus("high")] },
	// 3: S high, M medium, L low
	{ seats: 2, reviewers: [sol("xhigh"), opus("medium")] },
	// 4: M high, L medium, XL low
	{ seats: 2, reviewers: [sol("xhigh"), opus("high")] },
	// 5: L high, XL medium
	{ seats: 2, reviewers: [sol("xhigh"), opus("high")] },
	// 6: XL high
	{ seats: 2, reviewers: [sol("xhigh"), opus("xhigh")] },
];

/** The rung index (`0..6`) for `(size, tier)`: `XS..XL` (`0..4`) plus `low..high` (`0..2`). */
export const reviewRungIndex = (size: Size, tier: Tier): number => SIZES.indexOf(size) + TIERS.indexOf(tier);

/** The reviewer rung for `(size, tier)`. */
export const reviewRung = (size: Size, tier: Tier): ReviewRung => REVIEW_RUNGS[reviewRungIndex(size, tier)]!;

/** One side of the writer A/B: A runs the size's own first writer, B the alternative. */
export type Arm = "A" | "B";
export const ARM_NAMES: readonly Arm[] = ["A", "B"];

/**
 * The models that set a PR's risk tier from its diff, ranked: the first that
 * can run classifies, past any logged out or at its usage limit. The tier never depends on who wrote the change,
 * so the list is the same for every PR, unlike the reviewers'. Haiku is the
 * cheapest, and the classifier's prompt stays below the 100k input tokens past
 * which it costs five times as much.
 */
export const CLASSIFIERS: readonly Model[] = [
	{ harness: "claude", model: "claude-haiku-5-5", effort: "low" },
	sol("low"),
];

/**
 * The models that sort a finished session's time into categories, ranked as
 * the classifiers are. Haiku is the cheapest, and each prompt stays below its
 * 100k-token surcharge.
 */
export const SPLITTERS: readonly Model[] = [
	{ harness: "claude", model: "claude-haiku-5-5", effort: "low" },
	sol("low"),
];

/**
 * The stronger models that sort a sample of the same steps again, so each
 * split reports how often its classifier disagrees with a better judge.
 */
export const SPLIT_CHECKERS: readonly Model[] = [sonnet("medium"), sol("medium")];

/**
 * The writer A/B's running cohort, which every Implementer line on an armed PR names, as
 * `(arm B, cohort advisor-2026-11)`, so its readout never counts a PR an earlier A/B drew.
 */
export const COHORT = "advisor-2026-11";

/**
 * The writer A/B: each armed size's quests split between its first writer and a writer paired with Claude
 * Code's advisor tool, a stronger model the writer consults mid-task, until the readout in
 * quest/m0/routing-evidence/README.md deletes it. XS through M test whether Sonnet with Opus advising matches the
 * size's own writer for less; L and XL test whether Fable advising Opus pays for its price.
 */
export const ARMS: Partial<Record<Size, Record<Arm, Model>>> = {
	XS: { A: sonnet("high"), B: advised(sonnet("high"), "claude-opus-5-5") },
	S: { A: opus("medium"), B: advised(sonnet("high"), "claude-opus-5-5") },
	M: { A: opus("high"), B: advised(sonnet("high"), "claude-opus-5-5") },
	L: { A: opus("high"), B: advised(opus("high"), "claude-fable-5-2") },
	XL: { A: opus("xhigh"), B: advised(opus("xhigh"), "claude-fable-5-2") },
};

/** Whether two entries run the same harness, model, effort, and advisor. */
export const sameEntry = (a: Model, b: Model): boolean =>
	a.harness === b.harness && a.model === b.model && a.effort === b.effort && a.advisor === b.advisor;

/**
 * The writers that start quest `doc`, ranked, and its writer A/B arm and cohort. A quest
 * whose size runs an arm starts on the arm's entry, then the size's list
 * without it, so an arm whose advisor cannot run falls to the size's own writer; the arm hashes the quest's path,
 * so a restart or respawn draws the same one. A `Maintainer:` decision or prose wait leaves it a decision to
 * settle, so it runs the next size's list and no arm, which keeps each arm at
 * its PR's size; an action is only a step for the maintainer, not part of the work.
 */
export function questWriters(doc: Doc): { arm: Arm | null; cohort: string | null; models: readonly Model[] } {
	const sized = size(doc);
	// `quest check` requires a size of every quest that is not an epic, and only those can be ready.
	if (sized === null) throw new Error(`${doc.path} has no size`);
	if (waits(doc).some((wait) => onMaintainer(wait) && wait.kind !== "action"))
		return {
			arm: null,
			cohort: null,
			models: WRITERS[SIZES[Math.min(SIZES.indexOf(sized) + 1, SIZES.length - 1)]!],
		};
	const arms = ARMS[sized];
	if (!arms) return { arm: null, cohort: null, models: WRITERS[sized] };
	const arm = ARM_NAMES[createHash("sha256").update(doc.path).digest()[0]! & 1]!;
	const entry = arms[arm];
	return { arm, cohort: COHORT, models: [entry, ...WRITERS[sized].filter((e) => !sameEntry(e, entry))] };
}

/**
 * The entry that runs `model` on work of `size`: its own in that size's list,
 * else its entry at the nearest size that lists it, the larger on a tie, or
 * null when no list names it.
 */
export function writerAt(size: Size, model: string): Model | null {
	const at = SIZES.indexOf(size);
	const listed = SIZES.flatMap((each, index) => {
		const entry = WRITERS[each].find((e) => e.model === model);
		return entry ? [{ entry, distance: Math.abs(index - at), index }] : [];
	});
	listed.sort((a, b) => a.distance - b.distance || b.index - a.index);
	return listed[0]?.entry ?? null;
}
