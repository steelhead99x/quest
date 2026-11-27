import { expect, test } from "vitest";

import {
	ALWAYS_HIGH,
	classesFor,
	codeSpan,
	matches,
	parseRiskFile,
	patternError,
	recordedRisk,
	riskier,
} from "../src/core";
import { markdown } from "../src/core/doc";

test("a pattern is a path from the root whose * stays in a segment and whose ** spans segments", () => {
	const cases: [string, string, boolean][] = [
		// A plain path matches itself and everything under it, with or without a trailing slash.
		["src/billing", "src/billing", true],
		["src/billing", "src/billing/charge.ts", true],
		["src/billing/", "src/billing/charge.ts", true],
		["src/billing", "src/billing-old/charge.ts", false],
		["src/billing", "lib/src/billing/charge.ts", false],
		// `*` and `?` stay within one segment, from the root.
		["*.md", "RISK.md", true],
		["*.md", "docs/guide.md", false],
		["src/*/wire.ts", "src/moq/wire.ts", true],
		["src/*/wire.ts", "src/moq/lite/wire.ts", false],
		["v?.proto", "v2.proto", true],
		["v?.proto", "v10.proto", false],
		// `**` is any number of segments, none included.
		["**/*.proto", "wire.proto", true],
		["**/*.proto", "a/b/wire.proto", true],
		["src/**/wire.ts", "src/wire.ts", true],
		["src/**/wire.ts", "src/a/b/wire.ts", true],
		["src/**", "src", true],
		["src/**", "src/a/b", true],
		["**", "anything/at/all", true],
		// Adjacent `**` segments match what one does.
		["**/**/wire.proto", "wire.proto", true],
		["**/**/wire.proto", "a/b/wire.proto", true],
		["src/**/**/wire.ts", "src/wire.ts", true],
		["src/**/**/wire.ts", "src/a/wire.ts", true],
		["src/**/**", "src/a/b", true],
		["src/**/**", "lib/a", false],
		// A line break in a path is just another character, so it escapes no `**` or directory rule.
		["src/**", "src/a\nb/c.ts", true],
		["**", "a\nb", true],
		["src/**/wire.ts", "src/a\nb/wire.ts", true],
		["src/billing", "src/billing/a\nb.ts", true],
		["src/billing/", "src/billing/\n", true],
		["*.md", "a\nb.md", true],
		// Regular expression characters are literal.
		["a.b+c", "a.b+c", true],
		["a.b+c", "aXbbc", false],
	];
	for (const [pattern, path, expected] of cases) {
		expect(patternError(pattern), pattern).toBeNull();
		expect(matches(pattern, path), `${pattern} ${path}`).toBe(expected);
	}
	for (const [pattern, why] of [
		["", "empty"],
		["/etc", "starts with /"],
		["src//x", "empty, `.`, or `..` segment"],
		["../x", "`..` segment"],
		["src/**x", "whole segment"],
		["{a,b}", "do not support"],
		["src/[ab]", "do not support"],
		["has space", "do not support"],
	] as const)
		expect(patternError(pattern), pattern).toContain(why);
});

test("the built-in high paths hold the risk file, workflows, and actions", () => {
	const held = (path: string) => ALWAYS_HIGH.some((rule) => matches(rule.pattern, path));
	expect(held("RISK.md")).toBe(true);
	expect(held(".github/workflows/ci.yml")).toBe(true);
	expect(held(".github/actions/setup/action.yml")).toBe(true);
	expect(held(".github/dependabot.yml")).toBe(false);
	expect(held("docs/RISK.md")).toBe(false);
});

test("a risk file's ## High list is each backticked pattern and its reason; the rest is prose", () => {
	const text = [
		"# Risk",
		"",
		"Customers run the relay; the CLI is for contributors.",
		"",
		"## High",
		"",
		"The paths below always need a person.",
		"",
		"- `src/billing/` - charges customers,",
		"  and refunds are manual",
		"* `**/*.proto` - peers on older releases read the wire format",
		"",
		"## Customer-facing",
		"",
		"- `not/a/rule` - prose under another heading is never a rule",
	].join("\r\n");
	expect(parseRiskFile(text)).toEqual({
		high: [
			{ pattern: "src/billing/", reason: "charges customers, and refunds are manual" },
			{ pattern: "**/*.proto", reason: "peers on older releases read the wire format" },
		],
		classes: [],
		problems: [],
	});
	expect(parseRiskFile("# Risk\n\nNothing is always high here.\n")).toEqual({
		high: [],
		classes: [],
		problems: [],
	});

	const broken = parseRiskFile(
		[
			"## High",
			"",
			"- `/etc` - absolute",
			"- `src/` without a dash",
			"- src/ - not backticked",
			"- `deploy/` - nested",
			"  - `deploy/prod` - inside",
			"",
			"## High",
		].join("\n"),
	);
	expect(broken.high).toEqual([]);
	expect(broken.problems).toEqual([
		"RISK.md has 2 ## High sections; merge them into one",
		"RISK.md:3: `/etc` is no pattern: it starts with /, but a pattern is a path from the repository root",
		"RISK.md:4: a `## High` item is a backticked pattern, ` - `, and why its change is high",
		"RISK.md:5: a `## High` item is a backticked pattern, ` - `, and why its change is high",
		"RISK.md:6: a `## High` item is a backticked pattern, ` - `, and why its change is high",
	]);
});

test("the review record's risk reads back, and a record without one names none", () => {
	const record = (lines: string[]) =>
		["Summary.", "", "## Review", "", "Rewritten by `quest review` after each round.", "", ...lines].join("\r\n");
	const head = "a".repeat(40);
	expect(
		recordedRisk(
			record([
				`- Head: ${head}`,
				"- Base: origin/main at bbbbbbbbbbbb",
				"- Risk: high, ``` ``ships`` to peers ```",
				"- Classified: low by Codex, gpt-6.2-sol, low effort, session `thread-9`",
			]),
		),
	).toEqual({
		tier: "high",
		reason: "``ships`` to peers",
		classified: "low",
		by: "model",
		session: "thread-9",
		head,
		class: null,
		overridden: null,
		riskFile: "none",
	});
	expect(
		recordedRisk(
			record([
				"- Head: aaaaaaaaaaaa, named in full once no reviewer reports a finding",
				"- Risk: high, `it changes RISK.md, which is always high: it sets the tier of every later change`",
				"- Classified: high by the always-high paths",
			]),
		),
	).toMatchObject({ classified: "high", by: "paths", session: null, head: "aaaaaaaaaaaa" });
	expect(recordedRisk(record([`- Head: ${head}`]))).toBeNull();
	expect(recordedRisk("Summary.\n\n## Models\n\n- Size: S\n")).toBeNull();
	// A risk line `quest review` did not write reads as malformed, never as no record.
	const malformed = (lines: string[]) => recordedRisk(record([`- Head: ${head}`, ...lines]));
	expect(malformed(["- Risk: severe, `x`", "- Classified: low by default"])).toEqual({
		malformed: "the ## Review record's risk is malformed: severe, `x`",
	});
	expect(malformed(["- Risk: low, `x`"])).toEqual({
		malformed: "the ## Review record's risk is malformed: low, `x`",
	});
	expect(malformed(["- Risk:dire"])).toEqual({ malformed: "the ## Review record's risk is malformed: dire" });
	expect(malformed(["- Risk:low, `x`", "- Classified: low by default"])).toMatchObject({
		malformed: expect.any(String),
	});
	expect(malformed(["- Classified: low by default"])).toEqual({
		malformed: "the ## Review record's risk is malformed: it has no - Risk: line",
	});
});

test("a risk file's ## Automatic list names each class, its scope, and its rule", () => {
	const text = [
		"# Risk",
		"",
		"## Automatic",
		"",
		"Each class below lands without a pick once low.",
		"",
		"- `test` - only tests and their fixtures",
		"- `internal-docs` (`docs/**`, `**/*.md`,",
		"  `notes(old)/`) - documentation no user reads,",
		"  such as plans (under `quest/`)",
		"- `refactor`",
		"  (`src/**`) - code that behaves the same",
		"- `ticked` (``a`b``, `c/`) - (`f()` still returns the same) prose",
		"- `wrapped` ( `a/**`,",
		"  `b/**`",
		"  ) -",
		"  a scope and rule wrapped anywhere",
	].join("\n");
	expect(parseRiskFile(text)).toEqual({
		high: [],
		classes: [
			{ name: "test", scope: null, rule: "only tests and their fixtures" },
			{
				name: "internal-docs",
				scope: ["docs/**", "**/*.md", "notes(old)/"],
				rule: "documentation no user reads, such as plans (under `quest/`)",
			},
			{ name: "refactor", scope: ["src/**"], rule: "code that behaves the same" },
			// Any backtick run delimits a pattern, and a rule may open with parenthesized prose.
			{ name: "ticked", scope: ["a`b", "c/"], rule: "(`f()` still returns the same) prose" },
			{ name: "wrapped", scope: ["a/**", "b/**"], rule: "a scope and rule wrapped anywhere" },
		],
		problems: [],
	});

	const broken = parseRiskFile(
		[
			"## Automatic",
			"",
			"- `Tests` - capitalized",
			"- tests - not backticked",
			"- `docs` - one",
			"- `docs` - twice",
			"- `empty` () - no patterns",
			"- `bare` (docs/**) - unbackticked",
			"- `spaced` (`a/**` `b/**`) - no comma",
			"- `rooted` (`docs/**`, `/src`) - a pattern patternError refuses",
			"- `between` (`docs/**`) and more - text after the scope",
			"- `dashless`: a colon",
			"- `late` - (`quest/**`) a scope after the dash",
			"- `later` - (``docs/**``): a scope after the dash, then punctuation",
			"- `invalid` - (`/docs/**`) a misplaced scope whose pattern is no pattern",
			"- `entity` (`docs/**`&#41; or (`notes/**`) - an entity is no delimiter",
		].join("\n"),
	);
	expect(broken.classes).toEqual([
		{ name: "docs", scope: null, rule: "one" },
		{ name: "docs", scope: null, rule: "twice" },
	]);
	expect(broken.problems).toEqual([
		"RISK.md:3: `Tests` is no class name: use lowercase words joined by hyphens",
		"RISK.md:4: an `## Automatic` item is a backticked class name, optionally a scope of backticked path patterns in parentheses, ` - `, and the rule over the diff",
		"RISK.md:7: `empty`'s scope is empty: list its patterns, or drop the parentheses",
		"RISK.md:8: `bare`'s scope is not backticked path patterns joined by `, `",
		"RISK.md:9: `spaced`'s scope is not backticked path patterns joined by `, `",
		"RISK.md:10: `/src` in `rooted`'s scope is no pattern: it starts with /, but a pattern is a path from the repository root",
		"RISK.md:11: `between`'s scope must be followed by ` - ` and the rule, with nothing between",
		"RISK.md:12: `dashless` must be followed by its optional scope in parentheses, ` - `, and the rule over the diff",
		"RISK.md:13: `late`'s scope goes before ` - `, not at the start of its rule",
		"RISK.md:14: `later`'s scope goes before ` - `, not at the start of its rule",
		"RISK.md:15: `invalid`'s scope goes before ` - `, not at the start of its rule",
		"RISK.md:16: `entity`'s scope is not backticked path patterns joined by `, `",
		"RISK.md lists the class `docs` twice",
	]);
});

test("a change may fall only in the classes whose scope holds every path it changes", () => {
	const any = { name: "any", scope: null, rule: "anything" };
	const docs = { name: "docs", scope: ["docs/**", "**/*.md"], rule: "only documentation" };
	const code = { name: "code", scope: ["src/"], rule: "only code" };
	const classes = [any, docs, code];
	expect(classesFor(classes, ["docs/guide.txt", "src/README.md"])).toEqual([any, docs]);
	expect(classesFor(classes, ["src/a/b.ts"])).toEqual([any, code]);
	// One path outside a scope rules its class out, however many fit.
	expect(classesFor(classes, ["docs/guide.txt", "src/main.ts"])).toEqual([any]);
	// A scope names whole paths: a file pattern never covers a directory that fits it, and `src/` covers what it holds.
	expect(classesFor(classes, ["tools.md/build.sh"])).toEqual([any]);
	expect(classesFor([{ ...code, scope: ["src"] }], ["src/main.ts"])).toEqual([]);
	// A directory pattern holds only what lies strictly under a directory it names, never a file that fits it.
	const scratch = { name: "scratch", scope: ["*/**"], rule: "anything in a directory" };
	expect(classesFor([scratch], ["package.json"])).toEqual([]);
	expect(classesFor([scratch], ["notes/a.txt"])).toEqual([scratch]);
	// A change that touches no path falls in no class, not even an unscoped one.
	expect(classesFor(classes, [])).toEqual([]);
});

test("a code span renders its text whole, whatever backticks or edge spaces it holds", () => {
	for (const text of ["a", "a`b", "``", "`a", "a`", " a", "a ", " a ", "  a  ", " `a` ", " ", "  "]) {
		const paragraph = markdown(codeSpan(text)).children[0];
		expect(paragraph?.type === "paragraph" && paragraph.children).toEqual([
			expect.objectContaining({ type: "inlineCode", value: text }),
		]);
	}
});

test("the review record's class, override, and risk file read back", () => {
	const record = (lines: string[]) =>
		["## Review", "", `- Head: ${"a".repeat(40)}`, "- Risk: low, `the maintainer says so`", ...lines].join("\n");
	expect(
		recordedRisk(
			record([
				"- Overridden: from medium by the maintainer",
				"- Classified: low by default",
				"- Class: `tests`",
				"- Risk file: 0123456789ab",
			]),
		),
	).toMatchObject({ tier: "low", class: "tests", overridden: "medium", riskFile: "0123456789ab" });
	expect(recordedRisk(record(["- Classified: low by default", "- Risk file: none"]))).toMatchObject({
		riskFile: "none",
	});
	// A record from before the line names no risk file, which counts as the base having none.
	expect(recordedRisk(record(["- Classified: low by default"]))).toMatchObject({ riskFile: "none" });
	const malformed = { malformed: "the ## Review record's class, override, or risk file is malformed" };
	expect(recordedRisk(record(["- Classified: low by default", "- Class: tests"]))).toEqual(malformed);
	expect(recordedRisk(record(["- Classified: low by default", "- Overridden: by someone"]))).toEqual(malformed);
	// Like any risk line, one left alone makes a record whose risk is malformed, not absent.
	expect(recordedRisk(["## Review", "", "- Risk file: none"].join("\n"))).toEqual({
		malformed: "the ## Review record's risk is malformed: it has no - Risk: line",
	});
	// A full SHA would read as the reviewed head, so the record names the file by 12 characters.
	expect(recordedRisk(record(["- Classified: low by default", `- Risk file: ${"b".repeat(40)}`]))).toEqual(malformed);
});

test("tiers order from low to high", () => {
	expect(riskier("high", "medium")).toBe(true);
	expect(riskier("medium", "medium")).toBe(false);
	expect(riskier("low", "medium")).toBe(false);
});
