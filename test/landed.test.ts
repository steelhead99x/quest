// `quest check --base`: a PR from a quest's branch deletes or edits its quest.

import { execFileSync } from "node:child_process";

import { chmodSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { landingCheck } from "../src/cli/landed";
import { Tree, initRepository, tempDir } from "./fixture";

const FINDING = "neither deletes nor edits its quest since main";

/** The baseline tree committed on `main`, then checked out on `branch`. */
function repo(branch: string): Tree {
	const tree = Tree.committed();
	git(tree, "switch", "--quiet", "-c", branch);
	return tree;
}

function git(tree: Tree, ...args: string[]): string {
	return execFileSync("git", ["-C", tree.path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(tree: Tree, message: string) {
	git(tree, "add", "--all");
	git(tree, "commit", "--quiet", "--allow-empty", "-m", message);
}

test("a quest branch that deletes its quest passes", () => {
	const tree = repo("quest/m0/epic/one");
	// Finishing a quest edits only what it blocked, never its epic's README.
	tree.remove("quest/m0/epic/one.md").write("quest/m0/epic/two.md", "# [S] Two\n\n## Goal\n\nAnother quest.\n");
	commit(tree, "finish one");
	expect(tree.run("check", "--base", "main")).toEqual({ code: 0, stdout: "quest: 4 documents ok\n", stderr: "" });
});

test("a quest branch that edits its quest passes", () => {
	const tree = repo("quest/m0/epic/one");
	tree.append("quest/m0/epic/one.md", "\n## Plan\n\nWhat remains.\n");
	commit(tree, "trim one");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("a quest branch that leaves its quest untouched is a finding", () => {
	const tree = repo("quest/m0/epic/one");
	tree.write("src.ts", "work\n");
	commit(tree, "work");
	const out = tree.run("check", "--base", "main");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		`quest: quest/m0/epic/one.md: branch quest/m0/epic/one ${FINDING}; a PR that finishes a quest deletes it and ` +
			"every link to it, and one that leaves work rewrites it to what remains (`quest guide`, Execution)\n",
	);
	// A plain check is unchanged.
	expect(tree.run("check").code).toBe(0);
});

test("the working tree counts, before it is committed", () => {
	const tree = repo("quest/m0/epic/one");
	expect(tree.run("check", "--base", "main").stderr).toContain(FINDING);
	tree.append("quest/m0/epic/one.md", "\nMore.\n");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("an epic's branch, its README's path without .md, is checked against its README", () => {
	const tree = repo("quest/m0/epic/README");
	expect(tree.run("check", "--base", "main").stderr).toContain(
		`quest/m0/epic/README.md: branch quest/m0/epic/README ${FINDING}`,
	);
	tree.append("quest/m0/epic/README.md", "\nMore.\n");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("an epic's directory is not its branch", () => {
	expect(repo("quest/m0/epic").run("check", "--base", "main").code).toBe(0);
});

test("a branch that is not a quest branch adds no finding", () => {
	const tree = repo("fix/typo");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("a branch naming no quest at the merge base adds no finding", () => {
	const tree = repo("quest/m0/epic/three");
	tree.write("quest/m0/epic/three.md", "# [S] Three\n\n## Goal\n\nNew.\n");
	commit(tree, "plan three");
	expect(tree.run("check", "--base", "main").code).toBe(0);
});

test("--branch overrides the current branch", () => {
	const tree = repo("local-name");
	expect(tree.run("check", "--base", "main").code).toBe(0);
	expect(tree.run("check", "--base", "main", "--branch", "quest/m0/epic/two").stderr).toContain(
		`quest/m0/epic/two.md: branch quest/m0/epic/two ${FINDING}`,
	);
});

test("the base is compared from its merge base, not its tip", () => {
	const tree = repo("quest/m0/epic/two");
	// main moves on and edits the quest; the branch itself never touched it.
	git(tree, "switch", "--quiet", "main");
	tree.append("quest/m0/epic/two.md", "\nUpstream.\n");
	commit(tree, "upstream");
	git(tree, "switch", "--quiet", "quest/m0/epic/two");
	expect(tree.run("check", "--base", "main").stderr).toContain(FINDING);
});

test("a detached HEAD needs --branch", () => {
	const tree = repo("quest/m0/epic/one");
	git(tree, "switch", "--quiet", "--detach");
	const out = tree.run("check", "--base", "main");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("HEAD is not on a branch; pass --branch");
});

test("an unknown base fails", () => {
	const out = repo("quest/m0/epic/one").run("check", "--base", "nope");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("no merge base between nope and HEAD");
});

test("--branch without --base is a usage error", () => {
	expect(Tree.baseline().run("check", "--branch", "quest/m0/epic/one").code).toBe(2);
});

describe("quest merge's landing check", () => {
	/** Check `branch`'s tip in `tree` as `quest merge` would, fetching from `tree` into `root`. */
	function inspect(tree: Tree, branch: string, root = tempDir()) {
		const sha = git(tree, "rev-parse", branch).trim();
		const baseSha = git(tree, "rev-parse", "main").trim();
		return landingCheck(root)({ remote: tree.path, base: "main", baseSha, branch, sha, token: "token" });
	}

	test("finds a head that leaves its quest untouched, against the fetched base", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		const findings = await inspect(tree, "quest/m0/epic/one");
		expect(findings.map((finding) => [finding.path, finding.message])).toEqual([
			["quest/m0/epic/one.md", expect.stringContaining("neither deletes nor edits its quest since origin/main")],
		]);
	});

	test("passes a head that edits its quest, borrowing a checkout's objects", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.append("quest/m0/epic/one.md", "\n## Plan\n\nWhat remains.\n");
		commit(tree, "trim one");
		expect(await inspect(tree, "quest/m0/epic/one", tree.path)).toEqual([]);
	});

	test("reads the committed head, not a working tree", async () => {
		const tree = repo("quest/m0/epic/one");
		commit(tree, "nothing");
		// An uncommitted edit in the remote's own checkout is not part of the head.
		tree.append("quest/m0/epic/one.md", "\nMore.\n");
		expect(await inspect(tree, "quest/m0/epic/one")).toHaveLength(1);
	});

	test("reports a structural finding in the head's tree", async () => {
		const tree = repo("fix/link");
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "dangling link");
		const findings = await inspect(tree, "fix/link");
		expect(findings.map((finding) => finding.path)).toEqual(["quest/m0/epic/one.md"]);
	});

	test.skipIf(process.platform === "win32")(
		"reports a malformed quest.toml in the head's tree, and Nix tasks without its flake.nix",
		async () => {
			const tree = repo("fix/manifest");
			tree.write("quest.toml", '[tasks.a]\ntier = "pr"\nrun = "x"\nbogus = 1\n');
			commit(tree, "manifest");
			expect((await inspect(tree, "fix/manifest")).map((finding) => [finding.path, finding.message])).toEqual([
				["quest.toml", "[tasks.a]: unknown key `bogus`"],
			]);
			tree.write("quest.toml", '[tasks.a]\ntier = "pr"\nrun = "x"\n');
			commit(tree, "valid manifest");
			expect((await inspect(tree, "fix/manifest")).map((finding) => finding.message)).toEqual([
				expect.stringContaining("which needs Nix, but there is no flake.nix at its root"),
			]);
			symlinkSync("missing.nix", join(tree.path, "flake.nix"));
			commit(tree, "dangling flake");
			expect((await inspect(tree, "fix/manifest")).map((finding) => finding.message)).toEqual([
				expect.stringContaining("which needs Nix, but flake.nix is a symlink, not a regular file at its root"),
			]);
			rmSync(join(tree.path, "flake.nix"));
			tree.write("flake.nix", "{}\n");
			commit(tree, "flake");
			expect((await inspect(tree, "fix/manifest")).map((finding) => finding.message)).toEqual([
				expect.stringContaining("flake.nix's nixConfig must list https://nix.kixel.quest"),
			]);
			tree.write("flake.nix", '{ nixConfig.extra-substituters = [ "https://nix.kixel.quest" ]; }\n');
			commit(tree, "cached flake");
			expect(await inspect(tree, "fix/manifest")).toEqual([]);
			// The commit holds a symlink as its target's path, which quest check refuses too.
			tree.write("ci/tasks.toml", '[tasks.a]\ntier = "pr"\nrun = "x"\n');
			rmSync(join(tree.path, "quest.toml"));
			symlinkSync("ci/tasks.toml", join(tree.path, "quest.toml"));
			commit(tree, "linked manifest");
			expect((await inspect(tree, "fix/manifest")).map((finding) => finding.message)).toEqual([
				"must be a regular file, not a symlink",
			]);
		},
	);

	/** A tree whose `main` had a dangling link when `branch` left it, checked out on `branch`. */
	function brokenAtFork(branch: string): Tree {
		const tree = Tree.committed();
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "dangling link on main");
		git(tree, "switch", "--quiet", "-c", branch);
		return tree;
	}

	/** Fix `main`'s dangling link after the branch left it, as a later landing would. */
	function fixMain(tree: Tree, branch: string) {
		git(tree, "switch", "--quiet", "main");
		git(tree, "revert", "--no-edit", "HEAD");
		git(tree, "switch", "--quiet", branch);
	}

	test("skips a finding the merge base had, though the base fixed it since", async () => {
		const tree = brokenAtFork("fix/behind");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		fixMain(tree, "fix/behind");
		expect(await inspect(tree, "fix/behind")).toEqual([]);
	});

	test("reports a finding a behind head adds", async () => {
		const tree = brokenAtFork("fix/other");
		tree.append("quest/m0/epic/two.md", "\n## Related\n\n- [Lost](/quest/m0/lost.md) - missing\n");
		commit(tree, "another dangling link");
		// Up to date, the merge base is the base tip.
		expect((await inspect(tree, "fix/other")).map((finding) => finding.path)).toEqual(["quest/m0/epic/two.md"]);
		fixMain(tree, "fix/other");
		const findings = await inspect(tree, "fix/other");
		expect(findings.map((finding) => finding.path)).toEqual(["quest/m0/epic/two.md"]);
	});

	test("reports a new entry whose finding reads like one the base fixed", async () => {
		const tree = Tree.committed();
		tree.append("quest/m0/epic/two.md", "\n## Waiting\n\n- nobody named\n");
		commit(tree, "unattributed wait on main");
		git(tree, "switch", "--quiet", "-c", "fix/swap");
		tree.write("quest/m0/epic/two.md", tree.read("quest/m0/epic/two.md").replace("nobody named", "someone else"));
		commit(tree, "swap the wait");
		fixMain(tree, "fix/swap");
		expect((await inspect(tree, "fix/swap")).map((finding) => finding.path)).toEqual(["quest/m0/epic/two.md"]);
	});

	test("reports an entry the head changed below its opening line", async () => {
		const tree = Tree.committed();
		tree.append("quest/m0/epic/two.md", "\n## Waiting\n\n- nobody named\n  for one reason\n");
		commit(tree, "unattributed wait on main");
		git(tree, "switch", "--quiet", "-c", "fix/continued");
		tree.write("quest/m0/epic/two.md", tree.read("quest/m0/epic/two.md").replace("one reason", "another"));
		commit(tree, "reword the wait");
		fixMain(tree, "fix/continued");
		expect((await inspect(tree, "fix/continued")).map((finding) => finding.path)).toEqual(["quest/m0/epic/two.md"]);
	});

	test("reports a link below an entry's opening line once the head edits the entry", async () => {
		const tree = Tree.committed();
		tree.append("quest/m0/epic/two.md", "\n## Plan\n\n- first step\n  after [Gone](/quest/m0/gone.md)\n");
		commit(tree, "dangling link on main");
		git(tree, "switch", "--quiet", "-c", "fix/entry");
		tree.write("quest/m0/epic/two.md", tree.read("quest/m0/epic/two.md").replace("first step", "next step"));
		commit(tree, "reword the step");
		// The base fixes the link by adding its target, which leaves the head's lines alone.
		git(tree, "switch", "--quiet", "main");
		tree.write("quest/m0/gone.md", "# [S] Gone\n\n## Goal\n\nBack.\n");
		commit(tree, "add the target");
		git(tree, "switch", "--quiet", "fix/entry");
		expect((await inspect(tree, "fix/entry")).map((finding) => finding.message)).toEqual([
			"link does not resolve: /quest/m0/gone.md",
		]);
	});

	test("skips a finding whose entry changed only its line endings", async () => {
		const tree = Tree.committed();
		const path = "quest/m0/epic/two.md";
		tree.write(
			path,
			`${tree.read(path)}\n## Plan\n\n- first step\n  after [Gone](/quest/m0/gone.md)\n`.replaceAll("\n", "\r\n"),
		);
		commit(tree, "dangling link on main, in CRLF");
		git(tree, "switch", "--quiet", "-c", "fix/endings");
		tree.write(path, tree.read(path).replaceAll("\r\n", "\n"));
		commit(tree, "LF");
		expect(await inspect(tree, "fix/endings")).toEqual([]);
	});

	test("skips a finding the base tip has that the head carries without merging it", async () => {
		const tree = repo("fix/stacked");
		git(tree, "switch", "--quiet", "main");
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "dangling link on main");
		git(tree, "switch", "--quiet", "fix/stacked");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		git(tree, "cherry-pick", "main");
		// The head carries main's change on its own commit, so the merge base is main's parent.
		expect(git(tree, "merge-base", "main", "fix/stacked")).toBe(git(tree, "rev-parse", "main~"));
		expect(await inspect(tree, "fix/stacked")).toEqual([]);
	});

	test("reports a head whose quest tree it cannot read, though its merge base had the same", async () => {
		const tree = Tree.committed();
		writeFileSync(join(tree.path, "quest/m0/epic/one.md"), Buffer.from([0xff, 0xfe, 0x0a]));
		commit(tree, "unreadable quest on main");
		git(tree, "switch", "--quiet", "-c", "fix/unreadable");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		fixMain(tree, "fix/unreadable");
		expect((await inspect(tree, "fix/unreadable")).map((finding) => finding.path)).toEqual(["quest"]);
	});

	test("reports one more of a finding the merge base had", async () => {
		const tree = brokenAtFork("fix/again");
		tree.append("quest/m0/epic/one.md", "- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "the same dangling link");
		fixMain(tree, "fix/again");
		expect((await inspect(tree, "fix/again")).map((finding) => finding.path)).toEqual(["quest/m0/epic/one.md"]);
	});

	test("passes a head that branched before the base adopted quests", async () => {
		const tree = new Tree(initRepository());
		tree.write("README.md", "hi\n");
		// A placeholder file or a symlink is no quest document.
		tree.write("quest/.gitkeep", "");
		symlinkSync("../README.md", join(tree.path, "quest/roadmap.md"));
		commit(tree, "init");
		git(tree, "switch", "--quiet", "-c", "fix/early");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		git(tree, "switch", "--quiet", "main");
		Tree.baseline().copy(tree.path);
		commit(tree, "adopt quests");
		git(tree, "switch", "--quiet", "fix/early");
		expect(await inspect(tree, "fix/early")).toEqual([]);
	});

	test("fetches into a checkout's repository, writing none of its refs", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		const local = Tree.committed();
		const refs = git(local, "for-each-ref");
		expect(await inspect(tree, "quest/m0/epic/one", local.path)).toHaveLength(1);
		expect(git(local, "for-each-ref")).toBe(refs);
		// The head's objects arrived in the checkout's repository.
		git(local, "cat-file", "-e", git(tree, "rev-parse", "quest/m0/epic/one").trim());
	});

	test("does not borrow a shallow checkout's history", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.append("quest/m0/epic/one.md", "\nMore.\n");
		commit(tree, "edit");
		const shallow = tempDir();
		execFileSync("git", ["clone", "--quiet", "--depth=1", `file://${tree.path}`, shallow], { stdio: "ignore" });
		expect(await inspect(tree, "quest/m0/epic/one", shallow)).toEqual([]);
		// It fetched nothing into the shallow checkout.
		expect(() => git(new Tree(shallow), "cat-file", "-e", git(tree, "rev-parse", "main").trim())).toThrow();
	});

	test("does not write to a checkout it cannot write", async () => {
		const tree = repo("quest/m0/epic/one");
		tree.append("quest/m0/epic/one.md", "\nMore.\n");
		commit(tree, "edit");
		const local = Tree.committed();
		chmodSync(join(local.path, ".git/objects"), 0o555);
		try {
			expect(await inspect(tree, "quest/m0/epic/one", local.path)).toEqual([]);
		} finally {
			chmodSync(join(local.path, ".git/objects"), 0o755);
		}
	});

	test("a head that adopts quests is checked", async () => {
		const tree = new Tree(initRepository());
		tree.write("README.md", "hi\n");
		commit(tree, "init");
		git(tree, "switch", "--quiet", "-c", "adopt");
		Tree.baseline().copy(tree.path);
		tree.append("quest/m0/epic/one.md", "\n## Related\n\n- [Gone](/quest/m0/gone.md) - missing\n");
		commit(tree, "adopt quests");
		expect((await inspect(tree, "adopt")).map((finding) => finding.path)).toEqual(["quest/m0/epic/one.md"]);
	});

	test("a head that removes every quest is a finding", async () => {
		const tree = repo("fix/purge");
		git(tree, "rm", "--quiet", "-r", "quest");
		commit(tree, "purge");
		const findings = await inspect(tree, "fix/purge");
		expect(findings).toEqual([
			{ path: "quest", line: null, message: expect.stringContaining("no quest documents") },
		]);
	});

	test("a base without quests does not use them", async () => {
		const path = initRepository();
		const tree = new Tree(path);
		tree.write("README.md", "hi\n");
		commit(tree, "init");
		git(tree, "switch", "--quiet", "-c", "quest/m0/anything");
		tree.write("src.ts", "work\n");
		commit(tree, "work");
		expect(await inspect(tree, "quest/m0/anything")).toEqual([]);
	});

	test("fails on a head the remote does not have, and leaves no scratch repository", async () => {
		const tree = repo("quest/m0/epic/one");
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("quest-merge-")).length;
		const check = landingCheck(tempDir())({
			remote: tree.path,
			base: "main",
			baseSha: git(tree, "rev-parse", "main").trim(),
			branch: "quest/m0/epic/one",
			sha: "c".repeat(40),
			token: "token",
		});
		await expect(check).rejects.toThrow("git fetch failed");
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("quest-merge-")).length).toBe(before);
	});
});
