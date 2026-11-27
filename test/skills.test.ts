// The bundled skills and the stubs this repository installs.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { SKILL_DIRS } from "../src/core";
import { CONTEXT_LIMIT } from "../src/cli/hooks";
import { CONTEXT_PACKS, contextPack, contextPacks } from "../src/cli/context";
import { CONTEXT, GUIDE_SECTIONS, INLINE_LIMIT, SKILLS, guideSections, skill } from "../src/cli/skills";

test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s frontmatter is complete", (_, skill) => {
	expect(skill.description).not.toBe("");
	// The stub copies the description as a plain YAML scalar, where ": " is invalid.
	expect(skill.description).not.toContain(": ");
	expect(skill.body.trim()).not.toBe("");
});

test("skills are sorted and unique", () => {
	const names = SKILLS.map((skill) => skill.name);
	expect(names).toEqual([...new Set(names)].sort());
});

/**
 * The contract is no longer a file an adopter has, and what a skill builds on
 * arrives with it, so a skill pointing at either sends the agent looking again.
 */
test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s loads nothing itself", (_, skill) => {
	expect(skill.body).not.toContain("AGENTS.md");
	expect(skill.body).not.toMatch(/`quest (guide|skill)\b/);
	expect(skill.body).not.toMatch(/`quest context`'s/);
});

/**
 * This repository installs the same stubs as everyone else, so a skill added or
 * renamed here without its stub fails rather than going unused.
 */
test.each(SKILL_DIRS)("the repository's %s stubs are current", (path) => {
	const dir = join(import.meta.dirname, "..", path);
	expect(readdirSync(dir).sort()).toEqual(SKILLS.map((skill) => skill.installed));
	for (const skill of SKILLS) {
		expect(
			readFileSync(join(dir, skill.installed, "SKILL.md"), "utf8"),
			`${skill.name} stub is stale; regenerate it with \`quest init\``,
		).toBe(skill.stubs[path]);
	}
});

test("Claude Code's stub inlines the skill and pre-approves only its own call, in either shell", () => {
	const start = skill("start")!;
	expect(start.stubs[".claude/skills"]).toMatch(
		/^---\nname: quest-start\ndescription: Start work on a quest\.\nallowed-tools: Bash\(quest skill start\) PowerShell\(quest skill start\)\n---\n\n!`quest skill start; echo "[^"`$]*SETUP\.md[^"`$]*"`\n$/,
	);
	expect(start.stubs[".agents/skills"]).toContain("Run `quest skill start` and follow its output.");
});

test("a skill prints its own instructions first, then what it builds on, each once", () => {
	const plan = skill("plan")!;
	const text = skill("import")!.instructions;
	expect(text.startsWith(skill("import")!.body.trim())).toBe(true);
	// import builds on plan, which builds on the internal grill skill: each appears once, in that order.
	const planAt = text.indexOf(`# /quest-plan\n\n${plan.body.trim()}`);
	const grillAt = text.indexOf("# The grill skill\n\nInterview the user");
	expect(planAt).toBeGreaterThan(0);
	expect(grillAt).toBeGreaterThan(planAt);
	expect(text.split("# The grill skill").length).toBe(2);
	// The guide follows with every section any of them names, once and in the guide's order.
	const sections = [...new Set([...skill("import")!.guide, ...plan.guide, "Questions"])];
	expect(text.endsWith(`# Quest guide\n\n${guideSections(sections)}\n`)).toBe(true);
	expect(text.split("\n## Questions\n").length).toBe(2);
});

/** Claude Code inlines the stub's whole output: the composed skill, then the setup line it echoes. */
test.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s fits inline in Claude Code", (_, skill) => {
	const echoed = /; echo "([^"]*)"`/.exec(skill.stubs[".claude/skills"])![1]!;
	expect(skill.instructions.length + echoed.length + 1).toBeLessThanOrEqual(INLINE_LIMIT);
});

test("a skill that builds on nothing prints only its own instructions and guide sections", () => {
	const start = skill("start")!;
	expect(start.skills).toEqual([]);
	expect(start.instructions).toBe(`${start.body.trim()}\n\n# Quest guide\n\n${guideSections(start.guide)}\n`);
});

/** Grill only composes into the skills that interview the user, so no stub or listing offers it alone. */
test("an internal skill composes into others but is neither installed nor listed", () => {
	expect(skill("grill")).toBeUndefined();
	expect(SKILLS.map((s) => s.name)).toEqual(["afk", "import", "iterate", "merge", "plan", "review", "run", "start"]);
	for (const name of ["plan", "iterate", "run"]) expect(skill(name)!.instructions).toContain("# The grill skill\n\n");
});

test("the guide splits at its own headings, not the format example's", () => {
	expect(GUIDE_SECTIONS).toContain("Format");
	expect(GUIDE_SECTIONS).not.toContain("Goal");
	expect(guideSections(["format"])).toContain("## Goal\n\nThe observable outcome");
	expect(() => guideSections(["Nope"])).toThrow("no guide section named Nope");
});

/** The hook adds the rules to every session, and Claude Code shows only a preview of longer context. */
test("the rules every task loads fit in one hook's context", () => {
	expect(CONTEXT.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
	for (const pack of CONTEXT_PACKS) {
		expect(pack.body.trim()).not.toBe("");
		expect(pack.body.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
	}
	expect(contextPacks(["TS", "rust", "review"])).toContain("# Rust");
	expect(contextPacks(["TS", "rust", "review"])).toContain("# TypeScript");
	expect(contextPacks(["TS", "rust", "review"])).toContain("# Shared review rules");
	expect(() => contextPack("nope")).toThrow("no context pack named nope");
});
