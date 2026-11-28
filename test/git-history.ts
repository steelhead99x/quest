// A real repository's history, as the core's base-merge check reads it and as GitHub's REST API serves it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { History, TreeEntry } from "../src/core";
import { tempDir } from "./fixture";

const bin = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));

export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Whether `ancestor` is reachable from `commit`. */
function reaches(dir: string, commit: string, ancestor: string): boolean {
	return spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", ancestor, commit]).status === 0;
}

/** A repository on `main`, its `quest` merge driver this checkout's `quest resolve`. */
export function repository(): string {
	const dir = tempDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Quest test");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "merge.quest.driver", `bun --config='${bunfig}' '${bin}' resolve %A %O %B`);
	// Git's defaults, which a person's own config may change for `git merge`, and GitHub's merges keep.
	git(dir, "config", "diff.algorithm", "histogram");
	git(dir, "config", "merge.conflictStyle", "merge");
	return dir;
}

/** Commit `files` on the current branch, deleting each null one; returns the commit. */
export function commit(dir: string, files: Record<string, string | Uint8Array | null>, message = "edit"): string {
	for (const [path, content] of Object.entries(files)) {
		const file = join(dir, path);
		if (content === null) rmSync(file);
		else {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
		}
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

/** `dir`'s history, with `base` as the PR's base branch. */
export function gitHistory(dir: string, base = "main"): History {
	return {
		async commit(sha) {
			const [, ...parents] = git(dir, "rev-list", "--parents", "-n", "1", sha).split(" ");
			return { tree: git(dir, "rev-parse", `${sha}^{tree}`), parents };
		},
		async tree(oid) {
			const out = execFileSync("git", ["-C", dir, "ls-tree", "-z", oid], { encoding: "utf8" });
			return new Map(
				out
					.split("\0")
					.filter(Boolean)
					.map((line): [string, TreeEntry] => {
						const [info, name] = line.split("\t") as [string, string];
						const [mode, type, sha] = info.split(" ") as [string, TreeEntry["type"], string];
						return [name, { mode, type, oid: sha }];
					}),
			);
		},
		async blob(oid) {
			return new Uint8Array(execFileSync("git", ["-C", dir, "cat-file", "blob", oid]));
		},
		async mergeBase(a, b) {
			const bases = git(dir, "merge-base", "--all", a, b).split("\n").filter(Boolean);
			return bases.length === 1 ? bases[0]! : null;
		},
		async onBase(sha) {
			return reaches(dir, base, sha);
		},
	};
}

/**
 * The GitHub REST routes the base-merge check and the review readers call for `example/project`, answered from
 * `dir`: commits, trees, blobs, and comparisons, as JSON or as a diff. Undefined for any other request.
 */
export function gitRoutes(dir: string): (url: URL, init?: RequestInit) => Response | undefined {
	const prefix = "/repos/example/project";
	const resolve = (ref: string) => git(dir, "rev-parse", decodeURIComponent(ref));
	return (url, init) => {
		if (!url.pathname.startsWith(`${prefix}/`)) return undefined;
		const route = url.pathname.slice(prefix.length);
		const object = /^\/git\/(commits|trees|blobs)\/([0-9a-f]{40})$/.exec(route);
		if (object?.[1] === "commits") {
			const [, ...parents] = git(dir, "rev-list", "--parents", "-n", "1", object[2]!).split(" ");
			return Response.json({
				sha: object[2],
				tree: { sha: git(dir, "rev-parse", `${object[2]}^{tree}`) },
				parents: parents.map((sha) => ({ sha })),
			});
		}
		if (object?.[1] === "trees") {
			const tree = [
				...execFileSync("git", ["-C", dir, "ls-tree", "-z", object[2]!], { encoding: "utf8" }).split("\0"),
			]
				.filter(Boolean)
				.map((line) => {
					const [info, path] = line.split("\t") as [string, string];
					const [mode, type, sha] = info.split(" ");
					return { path, mode, type, sha };
				});
			return Response.json({ sha: object[2], tree, truncated: false });
		}
		if (object?.[1] === "blobs") {
			const bytes = execFileSync("git", ["-C", dir, "cat-file", "blob", object[2]!]);
			return Response.json({ sha: object[2], content: bytes.toString("base64"), encoding: "base64" });
		}
		const compare = /^\/compare\/(.+)\.\.\.([^.].*)$/.exec(route);
		if (!compare) return undefined;
		const [from, to] = [resolve(compare[1]!), resolve(compare[2]!)];
		if (new Headers(init?.headers).get("Accept") === "application/vnd.github.diff")
			return new Response(execFileSync("git", ["-C", dir, "diff", `${from}...${to}`], { encoding: "utf8" }));
		const status =
			from === to
				? "identical"
				: reaches(dir, from, to)
					? "behind"
					: reaches(dir, to, from)
						? "ahead"
						: "diverged";
		const count = (range: string) => Number(git(dir, "rev-list", "--count", range));
		return Response.json({
			status,
			// As git counts them, which GitHub's are.
			ahead_by: count(`${from}..${to}`),
			behind_by: count(`${to}..${from}`),
			base_commit: { sha: from },
			merge_base_commit: { sha: git(dir, "merge-base", from, to) },
			files: [],
		});
	};
}
