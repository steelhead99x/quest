// Whether a PR from a quest's branch leaves that quest accurate: it deletes
// the finished quest or rewrites it to what remains, so either way the diff
// from the base touches the quest's file. Reading the diff needs git, so it
// lives here rather than in the core.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Finding, branchQuest, check, parse } from "../core";
import { discoveryEnv } from "./git";
import { committedSources, hasQuests } from "./tree";

/**
 * A finding when `branch` (default: the current branch) is a quest's branch
 * and `head` (default: the working tree) neither deletes nor modifies that
 * quest relative to its merge base with `base`. Not a quest branch, or no such
 * quest at the merge base, is no finding. With `head`, `root` is the
 * repository's top level, as in a bare repository.
 */
export function landed(root: string, base: string, options: { branch?: string; head?: string } = {}): Finding[] {
	const name = options.branch ?? currentBranch(root);
	const commit = forkPoint(root, base, options.head ?? "HEAD");
	// Without a head, the pathspec and `<rev>:./path` are relative to the root,
	// which may sit below the repository's top level; a bare repository has no
	// work tree to be relative to.
	const relative = options.head === undefined ? "./" : "";
	const path = questAt(root, commit, name, relative);
	if (path === null) return [];
	const heads = options.head === undefined ? [] : [options.head];
	const diff = git(root, ["diff", "--quiet", "--no-ext-diff", commit, ...heads, "--", `${relative}${path}`]);
	if (diff.status === 1) return [];
	if (diff.status !== 0) throw new Error(`git diff ${commit} -- ${path}: ${diff.stderr.trim()}`);
	return [
		{
			path,
			line: null,
			message:
				`branch ${name} neither deletes nor edits its quest since ${base}; a PR that finishes a quest deletes ` +
				"it and every link to it, and one that leaves work rewrites it to what remains (`quest guide`, Execution)",
		},
	];
}

/** The PR head `quest merge` is about to land, and where to fetch it and its base. */
export interface LandingHead {
	/** The base repository's Git URL, which serves the head's commits even from a fork. */
	remote: string;
	/** The base branch's name, and the commit it points at. */
	base: string;
	baseSha: string;
	branch: string;
	sha: string;
	token: string;
}

/** Checks a head before `quest merge` queues it; resolves to its findings, empty when it may land. */
export type LandingCheck = (head: LandingHead) => Promise<Finding[]>;

/**
 * What `quest check --no-stubs --base <base> --branch <branch>` reports on `head.sha`, against a
 * freshly fetched base. The head is untrusted, so nothing from it runs or is checked out: the
 * check reads git objects. It fetches both commits by SHA into the repository of the checkout at
 * `root`, writing no ref, so Git sends only what that repository lacks and an interrupted run leaves
 * nothing behind. A checkout it cannot write, or a shallow one whose history could hide the merge
 * base, gives way to a temporary bare repository, as does no checkout.
 * A finding the head's merge base or the base already has, in an entry or line the head left
 * unchanged, is not the head's, so being behind the base adds none; an entry the head edits owns
 * its findings. A head with no quest documents skips the check when the base or its merge base
 * has none either.
 */
export function landingCheck(root: string): LandingCheck {
	return async (head) => {
		const local = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--is-shallow-repository"]);
		const [common, shallow] = local.stdout.trim().split("\n");
		const borrowed = local.status === 0 && shallow === "false" && writable(common);
		const dir = borrowed ? common : mkdtempSync(join(tmpdir(), "quest-merge-"));
		const { baseSha: base, sha: tip } = head;
		const run = (args: string[], env: Record<string, string> = {}) => {
			const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
				encoding: "utf8",
				env: { ...discoveryEnv(), GIT_TERMINAL_PROMPT: "0", ...env },
				maxBuffer: 1 << 30,
			});
			if (result.error) throw result.error;
			if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
			return result.stdout.trim();
		};
		// Findings and errors name the scratch directory and the base's SHA, which the refusal need not show.
		const tidy = (text: string) => text.replaceAll(`${dir}/`, "").replaceAll(base, `origin/${head.base}`);
		const tidied = (finding: Finding): Finding => ({ ...finding, message: tidy(finding.message) });
		try {
			if (!borrowed) run(["init", "--quiet", "--bare"]);
			// The token rides in the environment, after any configuration the user's environment already passes.
			const count = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
			const basic = Buffer.from(`x-access-token:${head.token}`).toString("base64");
			run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", head.remote, base, tip], {
				GIT_CONFIG_COUNT: String(count + 2),
				// An empty value drops any header the checkout already sends, such as actions/checkout's, which GitHub would reject as a duplicate.
				[`GIT_CONFIG_KEY_${count}`]: "http.https://github.com/.extraheader",
				[`GIT_CONFIG_VALUE_${count}`]: "",
				[`GIT_CONFIG_KEY_${count + 1}`]: "http.https://github.com/.extraheader",
				[`GIT_CONFIG_VALUE_${count + 1}`]: `Authorization: basic ${basic}`,
			});
			const [based, headed] = [hasQuests(dir, base), hasQuests(dir, tip)];
			if (!based && !headed) return [];
			let fork: string;
			let accurate: Finding[];
			try {
				fork = forkPoint(dir, base, tip);
				accurate = landed(dir, base, { branch: head.branch, head: tip });
			} catch (error) {
				throw new Error(tidy(error instanceof Error ? error.message : String(error)), { cause: error });
			}
			const forked = fork === base ? based : fork === tip ? headed : hasQuests(dir, fork);
			// A head that branched before the base adopted quests and adds none leaves them to the merge.
			if (!headed && !forked) return accurate.map(tidied);
			let tree: Keyed[];
			try {
				tree = treeCheck(dir, tip);
			} catch (error) {
				// An unreadable head hides what else it adds, so it is the head's to fix.
				return [{ path: "quest", line: null, message: String((error as Error).message) }, ...accurate].map(
					tidied,
				);
			}
			// A finding the head branched with is not this PR's, such as a dangling link or an old format the
			// base fixed since, whose fix the merge takes; nor is one the base tip has, as when the head
			// carries a base commit it did not merge, such as a squash-landed branch it was stacked on. One
			// more of the same in the head is.
			const known = new Map<string, number>();
			for (const ref of tree.length ? new Set([fork, base]) : []) {
				const counts = new Map<string, number>();
				for (const { key } of readable(dir, ref)) counts.set(key, (counts.get(key) ?? 0) + 1);
				for (const [key, count] of counts) known.set(key, Math.max(known.get(key) ?? 0, count));
			}
			const findings = tree
				.filter(({ key }) => {
					const left = known.get(key) ?? 0;
					known.set(key, left - 1);
					return left <= 0;
				})
				.map(({ finding }) => finding);
			return [...findings, ...accurate].map(tidied);
		} finally {
			if (!borrowed) rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** Whether this process may write the objects of the Git directory `dir`. */
function writable(dir: string): boolean {
	try {
		accessSync(join(dir, "objects"), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * A finding, keyed by its file, its message, and the source it points at: the whole entry holding its
 * line, continuation lines included, or else that line, split at line endings as the parser splits
 * them. The key survives edits elsewhere and changes of line ending.
 */
interface Keyed {
	finding: Finding;
	key: string;
}

/** `quest check`'s findings on `commit`, failing on a tree it cannot read, such as one with no quests. */
function treeCheck(dir: string, commit: string): Keyed[] {
	const { sources, exists } = committedSources(dir, commit, null);
	const docs = sources.map((source) => parse(source.path, source.text));
	const files = new Map(
		sources.map((source, index) => [
			source.path,
			{ lines: source.text.split(/\r\n?|\n/), entries: docs[index].entries },
		]),
	);
	// As `--no-stubs` does: a head may ship an audit this binary does not, with its stub.
	return check(docs, exists, { auditNames: false }).map((finding) => {
		const file = files.get(finding.path);
		const line = finding.line;
		if (line === null || file === undefined) return { finding, key: `${finding.path}\0${finding.message}\0` };
		const entry = file.entries.find(({ line: start, end }) => start <= line && line <= end);
		const text = file.lines.slice((entry?.line ?? line) - 1, entry?.end ?? line).join("\n");
		return { finding, key: `${finding.path}\0${finding.message}\0${text}` };
	});
}

/** `treeCheck` on a commit the head is screened against, where an unreadable tree screens nothing. */
function readable(dir: string, commit: string): Keyed[] {
	try {
		return treeCheck(dir, commit);
	} catch {
		return [];
	}
}

/** The quest file `branch` names, if it existed at `commit`. */
function questAt(root: string, commit: string, branch: string, relative: string): string | null {
	if (!branch.startsWith("quest/") || branch.endsWith("/")) return null;
	const path = branchQuest(branch);
	return git(root, ["cat-file", "-e", `${commit}:${relative}${path}`]).status === 0 ? path : null;
}

/** The commit where `head` branched from `base`, failing on unrelated histories. */
function forkPoint(root: string, base: string, head: string): string {
	const result = git(root, ["merge-base", base, head]);
	if (result.status !== 0)
		throw new Error(`no merge base between ${base} and ${head}: ${result.stderr.trim() || "unrelated histories"}`);
	return result.stdout.trim();
}

/** The branch checked out at `root`, failing on a detached HEAD with a hint to pass `flag`. */
export function currentBranch(root: string, flag = "--branch"): string {
	const head = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (head.status !== 0) throw new Error(`HEAD is not on a branch; pass ${flag} with the PR's head branch`);
	return head.stdout.trim();
}

function git(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: discoveryEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error(`running git: ${result.error.message}`);
	return result;
}
