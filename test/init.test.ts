import { spawnSync } from "node:child_process";
// `quest init` and `quest uninstall` in temporary repositories.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { expect, test } from "vitest";

import { AUDITS, check, formatFinding, ready } from "../src/core";
import { CONTEXT_LIMIT, hook } from "../src/cli/hooks";
import { REFERENCE_LINE, init, stubFindings, uninstall } from "../src/cli/setup";
import { CONTEXT, SKILLS } from "../src/cli/skills";
import { checkout, load } from "../src/cli/tree";
import { tempDir } from "./fixture";

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const isFile = (dir: string, path: string) => existsSync(join(dir, path)) && lstatSync(join(dir, path)).isFile();
const isSymlink = (dir: string, path: string) => {
	try {
		return lstatSync(join(dir, path)).isSymbolicLink();
	} catch {
		return false;
	}
};

test("init creates the layout and is idempotent", () => {
	const dir = tempDir();
	expect(init(dir)).not.toEqual([]);
	expect(isFile(dir, ".claude/skills/quest-start/SKILL.md")).toBe(true);
	expect(existsSync(join(dir, ".agents/skills/quest-start/SKILL.md"))).toBe(true);
	expect(isFile(dir, "quest/README.md")).toBe(true);
	expect(existsSync(join(dir, ".gitignore"))).toBe(false);
	expect(read(dir, "AGENTS.md")).toContain(REFERENCE_LINE);
	expect(init(dir)).toEqual([]);
});

test("init refuses a skill that is not a stub", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".claude/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".claude/skills/quest-start/SKILL.md"), "# My workflow\n");
	expect(() => init(dir)).toThrow("not a Quest stub");
});

test("a refused init writes nothing", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
	mkdirSync(join(dir, ".claude/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".claude/skills/quest-start/SKILL.md"), "# My workflow\n");
	const before = snapshot(dir);
	expect(() => init(dir)).toThrow(".claude/skills/quest-start/SKILL.md is not a Quest stub");
	expect(snapshot(dir)).toEqual(before);
});

/** Capture paths, types, file bytes, and link targets without following symlinks. */
function snapshot(dir: string): unknown[] {
	return readdirSync(dir)
		.sort()
		.map((name) => {
			const path = join(dir, name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) return [name, "symlink", readlinkSync(path)];
			if (stat.isDirectory()) return [name, "directory", snapshot(path)];
			return [name, "file", readFileSync(path)];
		});
}

for (const [path, type] of [
	["quest", "file"],
	["quest", "symlink"],
	["quest/README.md", "directory"],
	["quest/README.md", "symlink"],
	[".agents", "file"],
	[".agents", "symlink"],
	[".claude", "file"],
	[".claude/skills/quest-start", "file"],
	[".claude/skills/quest-start", "symlink"],
	[".claude/skills/quest-start/SKILL.md", "directory"],
	[".claude/skills/quest-start/SKILL.md", "symlink"],
	["AGENTS.md", "directory"],
	["AGENTS.md", "symlink"],
])
	test.skipIf(type === "symlink" && process.platform === "win32")(
		`init refuses ${path} as a ${type} before writing anything`,
		() => {
			const dir = tempDir();
			const conflict = join(dir, path);
			mkdirSync(dirname(conflict), { recursive: true });
			if (type === "directory") mkdirSync(conflict);
			else if (type === "symlink") symlinkSync("missing.md", conflict);
			else writeFileSync(conflict, "Keep these bytes.\n");
			const before = snapshot(dir);
			expect(() => init(dir)).toThrow(`${path} is not a`);
			expect(snapshot(dir)).toEqual(before);
		},
	);

for (const type of ["directory", "symlink"])
	test.skipIf(type === "symlink" && process.platform === "win32")(
		`init uses CLAUDE.md when AGENTS.md is a ${type}`,
		() => {
			const dir = tempDir();
			writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
			if (type === "directory") mkdirSync(join(dir, "AGENTS.md"));
			else symlinkSync("missing.md", join(dir, "AGENTS.md"));
			init(dir);
			expect(read(dir, "CLAUDE.md")).toContain(REFERENCE_LINE);
			expect(existsSync(join(dir, "missing.md"))).toBe(false);
			expect(lstatSync(join(dir, "AGENTS.md")).isDirectory()).toBe(type === "directory");
		},
	);

test("init appends to AGENTS.md, not CLAUDE.md, when both exist", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "AGENTS.md"), "# Repo\n\nKeep this.\n");
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude only\n");
	init(dir);
	expect(read(dir, "AGENTS.md")).toContain("Keep this.");
	expect(read(dir, "AGENTS.md")).toContain(REFERENCE_LINE);
	expect(read(dir, "CLAUDE.md")).not.toContain(REFERENCE_LINE);
});

test("init uses CLAUDE.md when only it exists", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
	init(dir);
	expect(read(dir, "CLAUDE.md")).toContain(REFERENCE_LINE);
	expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
});

test("an uninstall round trip preserves user content", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "AGENTS.md"), "# Repo\n\nUser rule.\n");
	mkdirSync(join(dir, "quest/m0"), { recursive: true });
	writeFileSync(join(dir, "quest/m0/plan.md"), "# [S] Keep\n\n## Goal\n\nStay.\n");
	init(dir);
	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe("# Repo\n\nUser rule.\n");
	expect(isFile(dir, "quest/m0/plan.md")).toBe(true);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});

test("a round trip with the Codex skills directory", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents/skills"), { recursive: true });
	init(dir);
	expect(isFile(dir, ".agents/skills/quest-start/SKILL.md")).toBe(true);
	expect(existsSync(join(dir, ".claude/skills/quest-start/SKILL.md"))).toBe(true);
	expect(lstatSync(join(dir, ".claude/skills")).isDirectory()).toBe(true);

	uninstall(dir);
	expect(existsSync(join(dir, ".agents/skills"))).toBe(false);
	expect(isSymlink(dir, ".claude/skills")).toBe(false);
});

test("init uses independent skill directories without creating symlinks", () => {
	const dir = tempDir();
	for (const skills of [".claude/skills", ".agents/skills"]) {
		mkdirSync(join(dir, skills, "custom"), { recursive: true });
		writeFileSync(join(dir, skills, "custom/SKILL.md"), `# ${skills} custom skill\n`);
	}
	init(dir);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		expect(lstatSync(join(dir, skills)).isDirectory()).toBe(true);
		expect(isFile(dir, `${skills}/quest-start/SKILL.md`)).toBe(true);
	}
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		expect(read(dir, `${skills}/custom/SKILL.md`)).toBe(`# ${skills} custom skill\n`);
		expect(existsSync(join(dir, skills, "quest-start"))).toBe(false);
	}
});

test("conflicts in the second destination prevent writes to the first", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents/skills/quest-start"), { recursive: true });
	writeFileSync(join(dir, ".agents/skills/quest-start/SKILL.md"), "# User workflow\n");
	const before = snapshot(dir);
	expect(() => init(dir)).toThrow(".agents/skills/quest-start/SKILL.md is not a Quest stub");
	expect(snapshot(dir)).toEqual(before);
});

test("setup and removal preserve CRLF instructions and recognize CRLF stubs", () => {
	const dir = tempDir();
	const original = "# Repository rules\r\n\r\nKeep this rule.\r\n";
	writeFileSync(join(dir, "AGENTS.md"), original);
	init(dir);
	expect(read(dir, "AGENTS.md")).toBe(`${original}\r\n${REFERENCE_LINE}\r\n`);
	for (const skills of [".claude/skills", ".agents/skills"]) {
		for (const skill of readdirSync(join(dir, skills))) {
			const path = `${skills}/${skill}/SKILL.md`;
			writeFileSync(join(dir, path), read(dir, path).replaceAll("\n", "\r\n"));
		}
	}
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe(original);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
});

test.skipIf(process.platform === "win32")("existing linked skills install once and uninstall cleanly", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".claude/skills"), { recursive: true });
	mkdirSync(join(dir, ".agents"));
	symlinkSync("../.claude/skills", join(dir, ".agents/skills"));
	const changed = init(dir);
	expect(changed.filter((path) => path.endsWith("SKILL.md"))).toHaveLength(SKILLS.length);
	// Claude Code and other agents read the same file, so it gets the stub every agent follows.
	const start = SKILLS.find((skill) => skill.name === "start")!;
	expect(read(dir, ".claude/skills/quest-start/SKILL.md")).toBe(start.stubs[".agents/skills"]);
	expect(init(dir)).toEqual([]);
	uninstall(dir);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});

test.skipIf(process.platform === "win32")("uninstall preserves an unrelated dangling skills link", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".agents"));
	symlinkSync("../user-owned", join(dir, ".agents/skills"));
	uninstall(dir);
	expect(readlinkSync(join(dir, ".agents/skills"))).toBe("../user-owned");
});

test("uninstall is idempotent", () => {
	const dir = tempDir();
	init(dir);
	uninstall(dir);
	expect(uninstall(dir)).toEqual([]);
});

test("init keeps a reworded reference line", () => {
	const dir = tempDir();
	const custom = "Quests: run `quest guide` first; skills live upstream.";
	writeFileSync(join(dir, "AGENTS.md"), `# Repo\n\n${custom}\n`);
	init(dir);
	expect(read(dir, "AGENTS.md")).toBe(`# Repo\n\n${custom}\n`);

	uninstall(dir);
	expect(read(dir, "AGENTS.md")).toBe("# Repo\n");
});

/** The stub an earlier release installed for `/quest-ready`, before `/quest-review` replaced it. */
const READY_STUB =
	"---\nname: quest-ready\ndescription: Mark a draft PR ready for review, wait for an automated review, then decide whether to merge.\n---\n\nRun `quest skill ready` and follow its output.\nIf `quest` is not installed, follow https://github.com/kixelated/quest/blob/main/SETUP.md first.\n";

/** A current skill's stub as an earlier release wrote it, with another description and setup link. */
const OLD_IMPORT_STUB =
	"---\nname: quest-import\ndescription: Audit outstanding quests for disagreements, then resolve them with /quest-plan.\n---\n\nRun `quest skill import` and follow its output.\nIf `quest` is not installed, follow https://github.com/kixelated/quest/blob/main/SETUP.md first.\n";

/** Claude Code's inline stub of a current skill, with another description and fallback text. */
const OLD_INLINE_IMPORT_STUB =
	'---\nname: quest-import\ndescription: Audit the quest tree.\nallowed-tools: Bash(quest skill import) PowerShell(quest skill import)\n---\n\n!`quest skill import; echo "install quest if that failed"`\n';

function write(dir: string, path: string, content: string) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

test("init removes stubs of retired skills and refreshes older stubs of current ones", () => {
	const dir = tempDir();
	init(dir);
	const imported = SKILLS.find((skill) => skill.name === "import")!;
	for (const skills of [".claude/skills", ".agents/skills"]) {
		const eol = skills === ".agents/skills" ? "\r\n" : "\n";
		write(dir, `${skills}/quest-ready/SKILL.md`, READY_STUB.replaceAll("\n", eol));
		write(dir, `${skills}/quest-import/SKILL.md`, OLD_IMPORT_STUB.replaceAll("\n", eol));
	}
	expect(init(dir)).toEqual([
		".claude/skills/quest-import/SKILL.md",
		".agents/skills/quest-import/SKILL.md",
		".claude/skills/quest-ready/SKILL.md",
		".agents/skills/quest-ready/SKILL.md",
	]);
	expect(existsSync(join(dir, ".claude/skills/quest-ready"))).toBe(false);
	expect(existsSync(join(dir, ".agents/skills/quest-ready"))).toBe(false);
	expect(read(dir, ".claude/skills/quest-import/SKILL.md")).toBe(imported.stubs[".claude/skills"]);
	expect(read(dir, ".agents/skills/quest-import/SKILL.md")).toBe(
		imported.stubs[".agents/skills"].replaceAll("\n", "\r\n"),
	);
	expect(init(dir)).toEqual([]);
});

test.skipIf(process.platform === "win32")("init leaves a linked older stub of a current skill", () => {
	const dir = tempDir();
	write(dir, "stub.md", OLD_IMPORT_STUB);
	write(dir, "elsewhere/quest-import/SKILL.md", OLD_IMPORT_STUB);
	mkdirSync(join(dir, ".claude/skills/quest-import"), { recursive: true });
	symlinkSync("../../../stub.md", join(dir, ".claude/skills/quest-import/SKILL.md"));
	mkdirSync(join(dir, ".agents/skills"), { recursive: true });
	symlinkSync("../../elsewhere/quest-import", join(dir, ".agents/skills/quest-import"));
	const changed = init(dir);
	expect(changed).not.toContain(".claude/skills/quest-import/SKILL.md");
	expect(changed).not.toContain(".agents/skills/quest-import/SKILL.md");
	expect(read(dir, "stub.md")).toBe(OLD_IMPORT_STUB);
	expect(read(dir, "elsewhere/quest-import/SKILL.md")).toBe(OLD_IMPORT_STUB);
});

test("init keeps a retired stub's directory when it holds other files", () => {
	const dir = tempDir();
	write(dir, ".claude/skills/quest-ready/SKILL.md", READY_STUB);
	write(dir, ".claude/skills/quest-ready/notes.md", "Mine.\n");
	expect(init(dir)).toContain(".claude/skills/quest-ready/SKILL.md");
	expect(readdirSync(join(dir, ".claude/skills/quest-ready"))).toEqual(["notes.md"]);
});

for (const [name, content] of [
	[
		"a user's own quest- skill",
		"---\nname: quest-ready\ndescription: My release checklist.\n---\n\nCheck the changelog.\n",
	],
	["a stub under another directory name", READY_STUB.replace("quest-ready", "quest-mine")],
	["a stub naming another skill", READY_STUB.replace("`quest skill ready`", "`quest skill mine`")],
	["a stub with added instructions", `${READY_STUB}Then tell the team.\n`],
	["a stub with an added frontmatter field", READY_STUB.replace("\n---\n\n", "\nallowed-tools: Bash\n---\n\n")],
] as const)
	test(`init and uninstall keep ${name}`, () => {
		const dir = tempDir();
		write(dir, ".claude/skills/quest-ready/SKILL.md", content);
		init(dir);
		uninstall(dir);
		expect(read(dir, ".claude/skills/quest-ready/SKILL.md")).toBe(content);
	});

test("init refreshes an inline stub, and moves each directory to its own kind", () => {
	const dir = tempDir();
	const imported = SKILLS.find((skill) => skill.name === "import")!;
	write(dir, ".claude/skills/quest-import/SKILL.md", OLD_INLINE_IMPORT_STUB);
	write(dir, ".agents/skills/quest-import/SKILL.md", OLD_INLINE_IMPORT_STUB);
	init(dir);
	expect(read(dir, ".claude/skills/quest-import/SKILL.md")).toBe(imported.stubs[".claude/skills"]);
	expect(read(dir, ".agents/skills/quest-import/SKILL.md")).toBe(imported.stubs[".agents/skills"]);
	write(dir, ".claude/skills/quest-import/SKILL.md", OLD_IMPORT_STUB);
	expect(init(dir)).toEqual([".claude/skills/quest-import/SKILL.md"]);
	expect(read(dir, ".claude/skills/quest-import/SKILL.md")).toBe(imported.stubs[".claude/skills"]);
});

for (const [layout, link] of [
	[
		"a linked skill directory",
		(dir: string) => symlinkSync("../../.claude/skills/quest-import", join(dir, ".agents/skills/quest-import")),
	],
	[
		"a linked SKILL.md",
		(dir: string) => {
			mkdirSync(join(dir, ".agents/skills/quest-import"));
			symlinkSync(
				"../../../.claude/skills/quest-import/SKILL.md",
				join(dir, ".agents/skills/quest-import/SKILL.md"),
			);
		},
	],
] as const)
	test.skipIf(process.platform === "win32")(
		`init gives ${layout} shared by both directories the stub every agent follows`,
		() => {
			const dir = tempDir();
			const imported = SKILLS.find((skill) => skill.name === "import")!;
			write(dir, ".claude/skills/quest-import/SKILL.md", OLD_INLINE_IMPORT_STUB);
			mkdirSync(join(dir, ".agents/skills"), { recursive: true });
			link(dir);
			expect(init(dir)).toContain(".claude/skills/quest-import/SKILL.md");
			expect(read(dir, ".agents/skills/quest-import/SKILL.md")).toBe(imported.stubs[".agents/skills"]);
			expect(init(dir)).toEqual([]);
		},
	);

for (const [name, content] of [
	["a stub with added instructions", `${OLD_IMPORT_STUB}Then tell the team.\n`],
	["a stub with an added frontmatter field", OLD_IMPORT_STUB.replace("\n---\n\n", "\nallowed-tools: Bash\n---\n\n")],
	[
		"an inline stub allowing more",
		OLD_INLINE_IMPORT_STUB.replace("PowerShell(quest skill import)", "PowerShell(quest skill import) Bash"),
	],
	[
		"an inline stub calling another skill",
		OLD_INLINE_IMPORT_STUB.replace("`quest skill import;", "`quest skill plan;"),
	],
	["an inline stub with added instructions", `${OLD_INLINE_IMPORT_STUB}Then tell the team.\n`],
] as const)
	test(`init keeps ${name} of a current skill`, () => {
		const dir = tempDir();
		write(dir, ".claude/skills/quest-import/SKILL.md", content);
		expect(() => init(dir)).toThrow(".claude/skills/quest-import/SKILL.md is not a Quest stub");
		expect(read(dir, ".claude/skills/quest-import/SKILL.md")).toBe(content);
	});

test("init leaves a user's skill without the quest- prefix", () => {
	const dir = tempDir();
	const ready = READY_STUB.replace("name: quest-ready", "name: ready");
	write(dir, ".claude/skills/ready/SKILL.md", ready);
	init(dir);
	expect(read(dir, ".claude/skills/ready/SKILL.md")).toBe(ready);
});

test.skipIf(process.platform === "win32")("init and uninstall leave linked retired stubs", () => {
	const dir = tempDir();
	write(dir, "elsewhere/quest-ready/SKILL.md", READY_STUB);
	write(dir, "stub.md", READY_STUB);
	mkdirSync(join(dir, ".claude/skills/quest-other"), { recursive: true });
	symlinkSync("../../elsewhere/quest-ready", join(dir, ".claude/skills/quest-ready"));
	symlinkSync("../../../stub.md", join(dir, ".claude/skills/quest-other/SKILL.md"));
	init(dir);
	uninstall(dir);
	expect(read(dir, "elsewhere/quest-ready/SKILL.md")).toBe(READY_STUB);
	expect(isSymlink(dir, ".claude/skills/quest-ready")).toBe(true);
	expect(isSymlink(dir, ".claude/skills/quest-other/SKILL.md")).toBe(true);
});

test("uninstall removes stubs that older versions installed", () => {
	const dir = tempDir();
	for (const skills of [".claude/skills", ".agents/skills"]) {
		write(dir, `${skills}/quest-ready/SKILL.md`, READY_STUB);
		write(dir, `${skills}/quest-import/SKILL.md`, OLD_IMPORT_STUB);
	}
	expect(uninstall(dir)).toEqual([
		".claude/skills/quest-import/SKILL.md",
		".claude/skills/quest-ready/SKILL.md",
		".agents/skills/quest-import/SKILL.md",
		".agents/skills/quest-ready/SKILL.md",
	]);
	expect(existsSync(join(dir, ".claude"))).toBe(false);
	expect(existsSync(join(dir, ".agents"))).toBe(false);
});

test("init and uninstall leave Claude Code's project settings alone", () => {
	const dir = tempDir();
	init(dir);
	expect(existsSync(join(dir, ".claude/settings.json"))).toBe(false);
	const text = `${JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "quest worktree hook" }] }] } })}\n`;
	write(dir, ".claude/settings.json", text);
	init(dir);
	uninstall(dir);
	expect(read(dir, ".claude/settings.json")).toBe(text);
});

test("stub check flags missing, outdated, and edited stubs, and the session hooks follow it", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	write(dir, "AGENTS.md", `${REFERENCE_LINE}\n`);
	const context = () =>
		["SessionStart", "SubagentStart"].map(
			(event) => JSON.parse(hook({ hook_event_name: event, cwd: dir })).hookSpecificOutput.additionalContext,
		);
	const flagged = (text: string) => text.includes("run `quest init` with the repository's pinned quest");

	// No stubs.
	expect(stubFindings(dir).some((line) => line.includes("is missing"))).toBe(true);
	expect(context().every(flagged)).toBe(true);

	// Current stubs.
	init(dir);
	expect(stubFindings(dir)).toEqual([]);
	expect(context().some(flagged)).toBe(false);

	// An older version's stub.
	write(dir, ".claude/skills/quest-import/SKILL.md", OLD_IMPORT_STUB);
	expect(stubFindings(dir)).toEqual([
		".claude/skills/quest-import/SKILL.md: is outdated; run the repository's pinned `quest init` and commit the result",
	]);
	expect(context().every(flagged)).toBe(true);

	// An edited stub init refuses to rewrite.
	write(dir, ".claude/skills/quest-import/SKILL.md", "my own skill\n");
	expect(stubFindings(dir)).toEqual([
		".claude/skills/quest-import/SKILL.md is not a Quest stub; remove or rename it before running `quest init`",
	]);
	expect(context().every(flagged)).toBe(true);
	expect(context()[0].length).toBeLessThanOrEqual(CONTEXT_LIMIT);
});

test("stub check asks for no audit stubs without a quest tree", () => {
	const dir = tempDir();
	init(dir);
	rmSync(join(dir, "quest"), { recursive: true });
	expect(stubFindings(dir)).toEqual([]);
});

test("the session hooks load the rules when the stub check cannot read the tree", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	init(dir);
	symlinkSync("loop.md", join(dir, "quest/loop.md"));
	const context = JSON.parse(hook({ hook_event_name: "SessionStart", cwd: dir })).hookSpecificOutput
		.additionalContext as string;
	expect(context.startsWith(CONTEXT)).toBe(true);
	expect(context).toContain("Quest could not compare the stubs here");
});

test("stub check adds nothing in a repository that does not use Quest", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	expect(hook({ hook_event_name: "SessionStart", cwd: dir })).toBe("");
});

test("quest check reports stubs from a relative root", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	write(dir, "AGENTS.md", `${REFERENCE_LINE}\n`);
	write(dir, "quest/README.md", "# Quests\n\n## Goal\n\nx\n");
	const run = (cwd: string) =>
		spawnSync("bun", ["run", "--silent", "quest", "--root", relative(process.cwd(), cwd), "check"], {
			encoding: "utf8",
		});
	const missing = run(dir);
	expect(missing.status).toBe(1);
	expect(missing.stderr).toContain("is missing");
	const skipped = spawnSync(
		"bun",
		["run", "--silent", "quest", "--root", relative(process.cwd(), dir), "check", "--no-stubs"],
		{ encoding: "utf8" },
	);
	expect(skipped.status).toBe(0);
	expect(skipped.stderr).toBe("");
	init(dir);
	expect(run(dir).status).toBe(0);
});

test("quest check reports a malformed risk file at the repository's root", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	write(dir, "AGENTS.md", `${REFERENCE_LINE}\n`);
	write(dir, "quest/README.md", "# Quests\n\n## Goal\n\nx\n");
	const run = () =>
		spawnSync("bun", ["run", "--silent", "quest", "--root", relative(process.cwd(), dir), "check", "--no-stubs"], {
			encoding: "utf8",
		});
	write(dir, "RISK.md", "# Risk\n\n## High\n\n- `/etc` - absolute\n- `src/` charges customers\n");
	const broken = run();
	expect(broken.status).toBe(1);
	expect(broken.stderr).toBe(
		[
			"quest: RISK.md:5: `/etc` is no pattern: it starts with /, but a pattern is a path from the repository root",
			"quest: RISK.md:6: a `## High` item is a backticked pattern, ` - `, and why its change is high",
			"",
		].join("\n"),
	);
	write(dir, "RISK.md", "# Risk\n\n## High\n\n- `src/billing/` - charges customers\n");
	expect(run()).toMatchObject({ status: 0, stderr: "" });
});

/** `quest check`'s findings on the tree under `dir`. */
function findings(dir: string): string[] {
	const tree = checkout(dir, () => {});
	return check(tree.docs, tree.exists).map(formatFinding);
}

const QUEST = "# [S] Work\n\n## Goal\n\nWork.\n";

/** The stub paths init plants in milestone `m`, in AUDITS order. */
const stubs = (m: string) => AUDITS.map((audit) => `quest/${m}/audit-${audit.name}.md`);

test("a fresh init plants each audit after an empty m0, ready at once", () => {
	const dir = tempDir();
	const changed = init(dir);
	expect(changed).toEqual(expect.arrayContaining(["quest/m0/README.md", "quest/m1/README.md", ...stubs("m1")]));
	const stub = read(dir, "quest/m1/audit-deps.md");
	expect(stub).toMatch(/^# \[M\] Audit dependencies\n\n## Goal\n\n.*`quest audit deps`.*\n\n## Audit\n\n- deps\n$/);
	expect(findings(dir)).toEqual([]);
	expect(ready(load(dir), "2026-11-10")).toEqual(stubs("m1").sort());
	expect(init(dir)).toEqual([]);
});

test("init plants each audit in the milestone after the lowest one with work left, requiring it", () => {
	const dir = tempDir();
	init(dir);
	for (const path of [...stubs("m1"), "quest/m1/README.md"]) rmSync(join(dir, path));
	// m0 is finished; m1 holds work, so the stubs wait for it in a new m2.
	write(dir, "quest/m1/README.md", "# Next\n\n## Goal\n\nNext.\n");
	write(dir, "quest/m1/work.md", QUEST);
	expect(init(dir)).toEqual(["quest/m2/README.md", ...stubs("m2")]);
	expect(read(dir, "quest/m2/audit-tree.md")).toContain(
		"\n## Required\n\n- [m1](/quest/m1/README.md) - the audit runs after it\n",
	);
	expect(findings(dir)).toEqual([]);
	expect(ready(load(dir), "2026-11-10")).toEqual(["quest/m1/work.md"]);
});

test("init plants no audit a quest names or the root skips, and never edits a planted stub", () => {
	const dir = tempDir();
	write(
		dir,
		"quest/README.md",
		"# Quests\n\n## Goal\n\nWork.\n\n## Skipped audits\n\n- deps - nothing to depend on\n- code\n- cost\n- docs\n- tests\n- instructions\n",
	);
	write(dir, "quest/m0/README.md", "# Now\n\n## Goal\n\nNow.\n");
	write(dir, "quest/m0/tree.md", `${QUEST}\n## Audit\n\n- tree\n`);
	expect(init(dir).filter((path) => path.startsWith("quest/"))).toEqual([]);
	expect(existsSync(join(dir, "quest/m1"))).toBe(false);

	write(
		dir,
		"quest/README.md",
		"# Quests\n\n## Goal\n\nWork.\n\n## Skipped audits\n\n- code\n- cost\n- docs\n- tests\n- instructions\n",
	);
	expect(init(dir)).toEqual(["quest/m1/README.md", "quest/m1/audit-deps.md"]);
	write(dir, "quest/m1/audit-deps.md", "# [L] Edited\n\n## Goal\n\nOurs.\n\n## Audit\n\n- deps\n");
	expect(init(dir)).toEqual([]);
});

test("init refuses a stub's path that other work holds, writing nothing", () => {
	const dir = tempDir();
	write(dir, "quest/README.md", "# Quests\n\n## Goal\n\nWork.\n");
	write(dir, "quest/m0/README.md", "# Now\n\n## Goal\n\nNow.\n");
	write(dir, "quest/m0/work.md", QUEST);
	write(dir, "quest/m1/README.md", "# Next\n\n## Goal\n\nNext.\n");
	write(dir, "quest/m1/audit-deps.md", QUEST);
	const before = snapshot(dir);
	expect(() => init(dir)).toThrow("quest/m1/audit-deps.md is in the way of the `deps` audit's stub");
	expect(snapshot(dir)).toEqual(before);
});

test("stub check reports a held audit path beside the skill stub findings", () => {
	const dir = tempDir();
	init(dir);
	write(dir, "quest/m0/work.md", QUEST);
	rmSync(join(dir, "quest/m1/audit-deps.md"));
	write(dir, "quest/m1/audit-deps.md", QUEST);
	rmSync(join(dir, ".claude/skills/quest-start"), { recursive: true });
	expect(stubFindings(dir)).toEqual([
		".claude/skills/quest-start/SKILL.md: is missing; run the repository's pinned `quest init` and commit the result",
		"quest/m1/audit-deps.md is in the way of the `deps` audit's stub, which no quest names; move it, or, if the maintainer declines the audit, list `deps` under `## Skipped audits` in `quest/README.md`, before running `quest init`",
	]);
});

test("stub check flags a shipped audit without a stub until a quest names it or the root skips it", () => {
	const dir = tempDir();
	init(dir);
	write(dir, "quest/m0/work.md", QUEST);
	const stub = read(dir, "quest/m1/audit-instructions.md");
	rmSync(join(dir, "quest/m1/audit-instructions.md"));
	expect(stubFindings(dir)).toEqual([
		"quest/m1/audit-instructions.md: is missing; run the repository's pinned `quest init` and commit the result, or, if the maintainer declines the audit, list `instructions` under `## Skipped audits` in `quest/README.md`",
	]);

	write(dir, "quest/m1/audit-instructions.md", stub);
	expect(stubFindings(dir)).toEqual([]);

	// A heading `quest check` flags as non-literal still names the audit, so nothing would plant a second stub.
	write(dir, "quest/m1/audit-instructions.md", stub.replace("## Audit\n", "Audit\n-----\n"));
	expect(stubFindings(dir)).toEqual([]);
	expect(init(dir)).toEqual([]);
	write(
		dir,
		"quest/m1/audit-instructions.md",
		`# Instructions\n${stub.slice(stub.indexOf("\n"))}`.replace("## Audit\n", "## Au**dit**\n"),
	);
	expect(stubFindings(dir)).toEqual([]);
	expect(init(dir)).toEqual([]);

	rmSync(join(dir, "quest/m1/audit-instructions.md"));
	write(dir, "quest/README.md", `${read(dir, "quest/README.md")}\n## *Skipped* _audits_\n\n- instructions\n`);
	expect(stubFindings(dir)).toEqual([]);
});

test("init refuses a quest whose branch a new milestone would nest under", () => {
	const dir = tempDir();
	write(dir, "quest/README.md", "# Quests\n\n## Goal\n\nWork.\n");
	write(dir, "quest/m0/README.md", "# Now\n\n## Goal\n\nNow.\n");
	write(dir, "quest/m0/work.md", QUEST);
	write(dir, "quest/m1.md", QUEST);
	expect(() => init(dir)).toThrow("quest/m1.md is in the way of milestone m1");
	expect(existsSync(join(dir, "quest/m1"))).toBe(false);
});
