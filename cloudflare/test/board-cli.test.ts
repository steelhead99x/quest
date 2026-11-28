// The board must agree with the CLI: rank and list waiting work in the same
// order, from the same tree. These run the real `quest` on each fixture tree
// and compare it with the board model the Worker renders.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isQuest } from "../../src/core/index.ts";
import type { Tree } from "../src/board/load.ts";
import { board, today } from "../src/board/model.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "cli", "bin.ts");
const NOW = Date.now();
// The CLI reads Scheduled dates on this machine's calendar, so compare on the same one.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write `files` into a fresh directory and return it. */
function checkout(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "quest-board-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

/** Every Markdown file under `quest/` of a checkout, as the loader returns them. */
function documents(dir: string): Tree["documents"] {
	const out: Tree["documents"] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (isQuest(name)) out.push({ path: relative(dir, p), content: readFileSync(p, "utf8") });
		}
	};
	walk(join(dir, "quest"));
	return out;
}

function tree(dir: string): Tree {
	return {
		repository: "o/r",
		upstream: "o/r",
		url: "https://github.com/o/r",
		private: false,
		branch: "main",
		commit: "0".repeat(40),
		committed: "",
		documents: documents(dir),
		pulls: [],
		branches: [],
		workflows: [],
		gaps: [],
	};
}

/** Run the CLI in `dir`, returning its stdout, or its failure when `fails`. */
function quest(dir: string, args: string[], fails = false): string {
	try {
		// From the repository root, whose bunfig.toml loads the CLI's Markdown assets.
		const out = execFileSync("bun", [CLI, "--root", dir, ...args], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
		});
		if (fails) throw new Error(`quest ${args.join(" ")} succeeded`);
		return out;
	} catch (error) {
		if (!fails) throw error;
		return String((error as { stderr?: string }).stderr ?? error);
	}
}

const fixtures: Record<string, Record<string, string>> = {
	"required, scheduled, and waiting": {
		"quest/README.md": "# Quests\n\n## Goal\n\nShip.\n",
		"quest/m0/README.md": "# Now\n\n## Goal\n\nFirst.\n",
		"quest/m0/a.md": "# [S] A\n\n## Goal\n\nA.\n",
		"quest/m0/b.md": "# [M] B\n\n## Goal\n\nB.\n\n## Required\n\n- [A](/quest/m0/a.md) - first\n",
		"quest/m0/c.md": "# [L] C\n\n## Goal\n\nC.\n\n## Required\n\n- [B](/quest/m0/b.md) - then\n",
		"quest/m0/d.md": "# [XS] D\n\n## Goal\n\nD.\n\n## Waiting\n\n- Maintainer: pick one\n",
		"quest/m0/later.md": "# [S] Later\n\n## Goal\n\nL.\n\n## Scheduled\n\n- 2999-01-01 - not yet\n",
		"quest/m0/epic/README.md": "# Epic\n\n## Goal\n\nE.\n\n## Required\n\n- [A](/quest/m0/a.md) - gate\n",
		"quest/m0/epic/e1.md": "# [S] E1\n\n## Goal\n\nE1.\n",
		"quest/m1/README.md": "# Next\n\n## Goal\n\nSecond.\n",
		"quest/m1/x.md": "# [M] X\n\n## Goal\n\nX.\n\n## Waiting\n\n- moq-dev/moq: a release\n",
	},
};

describe("the board agrees with the CLI", () => {
	const cases: [string, string][] = [
		...Object.entries(fixtures).map(([name, files]) => [name, checkout(files)] as [string, string]),
		["this repository's own tree", ROOT],
	];

	test.each(cases)("%s: ready ranking", (_, dir) => {
		const cli = JSON.parse(quest(dir, ["unblocked", "--json"])) as { path: string; dependents: number }[];
		const b = board(tree(dir), NOW, ZONE);
		expect(b.findings).toEqual([]);
		expect(b.ranked.map((r) => [r.path, r.dependents])).toEqual(cli.map((r) => [r.path, r.dependents]));
	});

	test.each(cases)("%s: waiting items", (_, dir) => {
		// Both inputs contain only local quest documents. Skip live drafts even in an authenticated clone.
		const cli = JSON.parse(quest(dir, ["waiting", "--json", "--remote", "quest-board-test-no-remote"])) as {
			path: string;
			waits: { text: string }[];
		}[];
		const b = board(tree(dir), NOW, ZONE);
		expect(b.waiting.map((w) => [w.path, w.waits.map((x) => x.text)])).toEqual(
			cli.map((w) => [w.path, w.waits.map((x) => x.text)]),
		);
	});

	test("the fixture's states and counts", () => {
		const b = board(tree(checkout(fixtures["required, scheduled, and waiting"]!)), NOW, ZONE);
		const state = Object.fromEntries([...b.quests.values()].map((q) => [q.path.split("/").pop(), q.status]));
		expect(state).toEqual({
			"a.md": "ready",
			"b.md": "blocked",
			"c.md": "blocked",
			"d.md": "ready",
			"later.md": "blocked",
			"e1.md": "blocked",
			"x.md": "ready",
		});
		expect(b.counts).toEqual({ ready: 3, blocked: 4, claimed: 0, review: 0 });
		expect(b.sizes).toEqual({ XS: 1, S: 3, M: 2, L: 1, XL: 0, unsized: 0 });
		expect(b.milestones.map((m) => [m.path, m.total])).toEqual([
			["quest/m0/README.md", 6],
			["quest/m1/README.md", 1],
		]);
		expect(today(Date.UTC(2026, 10, 25, 23, 59), "UTC")).toBe("2026-11-25");
	});

	test("Scheduled dates are read on the configured timezone's calendar", () => {
		// 02:00 UTC on the 25th is still the evening of the 24th in Los Angeles.
		const at = Date.UTC(2026, 10, 25, 2, 0);
		expect(today(at, "UTC")).toBe("2026-11-25");
		expect(today(at, "America/Los_Angeles")).toBe("2026-11-24");
		const dir = checkout({
			"quest/README.md": "# Quests\n\n## Goal\n\nShip.\n",
			"quest/m0/README.md": "# Now\n\n## Goal\n\nFirst.\n",
			"quest/m0/later.md":
				"# [S] Later\n\n## Goal\n\nLater.\n\n## Scheduled\n\n- 2026-11-25 - the day it opens\n",
		});
		const status = (zone: string) => board(tree(dir), at, zone).quests.get("quest/m0/later.md")?.status;
		expect(status("UTC")).toBe("ready");
		expect(status("America/Los_Angeles")).toBe("blocked");
	});

	test("an invalid tree is reported as the CLI reports it, and nothing is ranked", () => {
		const dir = checkout({
			"quest/README.md": "# Quests\n\n## Goal\n\nShip.\n",
			"quest/m0/README.md": "# Now\n\n## Goal\n\nFirst.\n",
			"quest/m0/a.md": "# [S] A\n\n## Goal\n\nA.\n\n## Required\n\n- [B](/quest/m0/b.md) - loop\n",
			"quest/m0/b.md": "# [S] B\n\n## Goal\n\nB.\n\n## Required\n\n- [A](/quest/m0/a.md) - loop\n",
		});
		const cli = quest(dir, ["check"], true);
		const b = board(tree(dir), NOW, ZONE);
		expect(b.findings.length).toBeGreaterThan(0);
		for (const finding of b.findings) expect(cli).toContain(finding.split(": ").slice(1).join(": "));
		expect(b.ranked).toEqual([]);
		expect(b.waiting).toEqual([]);
	});

	test("claims from branches and PRs set each quest's state", () => {
		const t = tree(checkout(fixtures["required, scheduled, and waiting"]!));
		const pull = (n: number, branch: string, draft: boolean, body = "") => ({
			number: n,
			url: `https://github.com/o/r/pull/${n}`,
			title: `PR ${n}`,
			draft,
			branch,
			head: "c".repeat(40),
			author: "octo",
			body,
			created: "2026-11-01T00:00:00Z",
			repository: "o/r",
		});
		t.branches = ["quest/m0/a", "quest/m0/d"];
		t.pulls = [
			pull(1, "quest/m0/d", true, "Work.\n\n## Waiting\n\n- Maintainer: choose\n"),
			pull(2, "quest/m1/x", false),
			pull(3, "quest/m1/x", true),
		];
		const b = board(t, NOW, ZONE);
		expect(b.quests.get("quest/m0/a.md")).toMatchObject({ status: "claimed", pull: null });
		expect(b.quests.get("quest/m0/d.md")).toMatchObject({ status: "claimed", handedBack: true });
		expect(b.quests.get("quest/m1/x.md")?.pull?.number).toBe(2);
		expect(b.quests.get("quest/m1/x.md")?.status).toBe("review");
		expect(b.ranked).toEqual([]);
		expect(b.waiting.some((w) => w.pr === "https://github.com/o/r/pull/1")).toBe(true);
	});
});
