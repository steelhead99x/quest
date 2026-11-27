import { expect, test } from "vitest";

import {
	type Doc,
	check,
	handBackProblems,
	handBackWaits,
	handedBack,
	onMaintainer,
	parse,
	readWait,
	unblocked,
	waiting,
	waitLine,
	withoutHandBack,
} from "../src/core";
import { TODAY } from "./fixture";

/** A tree of two milestones and their quests. */
function tree(m0: Record<string, string>, m1: Record<string, string> = {}): Doc[] {
	const milestone = (name: string, quests: Record<string, string>) => [
		parse(`quest/${name}/README.md`, `# ${name}\n\n## Goal\n\nWork.\n`),
		...Object.entries(quests).map(([q, body]) =>
			parse(`quest/${name}/${q}`, `# [S] ${q}\n\n## Goal\n\nWork.\n${body}`),
		),
	];
	return [parse("quest/README.md", "# Quests\n\n## Goal\n\nAll.\n"), ...milestone("m0", m0), ...milestone("m1", m1)];
}

test("a wait opens with its party", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Goal\n\nA.\n\n## Waiting\n\n- Maintainer: open the account,\n  then check `GET /server`.\n- moq-dev/moq: a release carries the fix.\n- No party is named here\n- This sentence runs on far too long before it reaches a colon: so it is prose\n",
	);
	const [account, release, none, prose] = doc.entries.map((entry) => readWait(entry).wait);
	expect(account).toEqual({
		line: 9,
		party: "Maintainer",
		kind: "prose",
		text: "open the account, then check GET /server.",
	});
	expect(release).toMatchObject({ party: "moq-dev/moq", kind: "prose", text: "a release carries the fix." });
	expect(none).toBeNull();
	expect(prose).toBeNull();
});

test("Maintainer (action) and (PC) are the maintainer's actions, and no other qualifier parses", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Waiting\n\n- Maintainer (PC): unlock the vault.\n- maintainer(pc): plug in the camera.\n" +
			"- Maintainer (local): log in.\n- Maintainers: agree.\n- Maintainer (Action): approve the install.\n",
	);
	const [vault, camera, local, plural, install] = doc.entries.map((entry) => readWait(entry).wait);
	expect(vault).toEqual({ line: 5, party: "Maintainer", kind: "action", pc: true, text: "unlock the vault." });
	expect(camera).toMatchObject({ party: "Maintainer", kind: "action", pc: true });
	expect(local).toBeNull();
	expect(plural).toMatchObject({ party: "Maintainers", kind: "prose" });
	expect(install).toEqual({ line: 9, party: "Maintainer", kind: "action", pc: false, text: "approve the install." });
	expect(onMaintainer(vault!)).toBe(true);
	expect(onMaintainer(plural!)).toBe(false);
	expect(handBackWaits("## Waiting\n\n- Maintainer (PC): unlock.\n- Maintainer (home): log in.\n")).toEqual([
		{ line: 3, party: "Maintainer", kind: "action", pc: true, text: "unlock." },
		{ line: 4, party: "Maintainer", kind: "prose", text: "Maintainer (home): log in." },
	]);
});

test("waiting drops PC steps on request, keeping other actions, and ranks by the items it keeps", () => {
	const docs = tree({
		"a.md": "\n## Waiting\n\n- Maintainer (PC): unlock the vault.\n- moq-dev/moq: a release.\n",
		"b.md": "\n## Waiting\n\n- Maintainer: pick a name.\n- Maintainer (PC): log in.\n- Maintainer (action): approve.\n",
		"c.md": "\n## Waiting\n\n- moq-dev/moq: another release.\n",
	});
	const shown = (options: Parameters<typeof waiting>[2]) =>
		waiting(docs, TODAY, options).map((quest) => [quest.path, quest.waits.map((wait) => wait.text)]);
	expect(shown({})).toEqual([
		["quest/m0/a.md", ["unlock the vault.", "a release."]],
		["quest/m0/b.md", ["pick a name.", "log in.", "approve."]],
		["quest/m0/c.md", ["another release."]],
	]);
	// Without its PC step, a.md waits only on an outside party, so it ranks after b.md.
	expect(shown({ pc: false })).toEqual([
		["quest/m0/b.md", ["pick a name.", "approve."]],
		["quest/m0/a.md", ["a release."]],
		["quest/m0/c.md", ["another release."]],
	]);
	expect(shown({ maintainer: true, pc: false })).toEqual([["quest/m0/b.md", ["pick a name.", "approve."]]]);
	expect(shown({ maintainer: true })).toEqual([
		["quest/m0/a.md", ["unlock the vault."]],
		["quest/m0/b.md", ["pick a name.", "log in.", "approve."]],
	]);
});

test("a decision is a Maintainer item with a marked choice list, from a quest and a draft alike", () => {
	const item =
		"- Maintainer: which runner builds the Windows suite?\n" +
		"  - GitHub-hosted (Recommended) - no machine to keep up\n" +
		"  - Self-hosted - free minutes, but a Windows host\n";
	const decision = {
		line: 5,
		party: "Maintainer",
		kind: "decision",
		text: "which runner builds the Windows suite?",
		choices: [
			{ label: "GitHub-hosted", description: "no machine to keep up", recommended: true },
			{ label: "Self-hosted", description: "free minutes, but a Windows host", recommended: false },
		],
	};
	expect(readWait(parse("quest/m0/a.md", `# [S] A\n\n## Waiting\n\n${item}`).entries[0])).toEqual({
		wait: decision,
		problems: [],
	});
	expect(handBackWaits(`Work.\n\n## Waiting\n\n${item}`)).toEqual([decision]);
	expect(handBackProblems(`Work.\n\n## Waiting\n\n${item}`)).toEqual([]);
});

test("a choice's label comes from its own paragraph, and nested detail joins its description", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Waiting\n\n- Maintainer: which host?\n  - Hetzner (Recommended)\n    - cheap - but EU only\n" +
			"  - OVH - hourly\n    - more detail\n",
	);
	expect(readWait(doc.entries[0]).wait).toMatchObject({
		kind: "decision",
		choices: [
			{ label: "Hetzner", description: "cheap - but EU only", recommended: true },
			{ label: "OVH", description: "hourly more detail", recommended: false },
		],
	});
});

test("a decision keeps the detail lists beside its choice list in its text", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Waiting\n\n- Maintainer: which provider?\n  - Hetzner bills monthly\n  - OVH bills hourly\n\n" +
			"  Pick one:\n\n  - Hetzner (recommended)\n  - OVH\n",
	);
	expect(readWait(doc.entries[0]).wait).toEqual({
		line: 5,
		party: "Maintainer",
		kind: "decision",
		text: "which provider? Hetzner bills monthly OVH bills hourly Pick one:",
		choices: [
			{ label: "Hetzner", description: null, recommended: true },
			{ label: "OVH", description: null, recommended: false },
		],
	});
});

test("an unmarked list, or a marker mid-sentence outside a decision, stays prose", () => {
	const doc = parse(
		"quest/m0/a.md",
		"# [S] A\n\n## Waiting\n\n- Maintainer: can you check these?\n  - the DNS record\n  - the certificate\n" +
			"- moq-dev/moq: a release ships.\n  - Review logs (recommended) before release\n  - Tag it\n" +
			"- Maintainer (action): deploy.\n  - Back up first (recommended) to be safe\n",
	);
	expect(doc.entries.map((entry) => readWait(entry))).toEqual([
		{
			wait: {
				line: 5,
				party: "Maintainer",
				kind: "prose",
				text: "can you check these? the DNS record the certificate",
			},
			problems: [],
		},
		{
			wait: {
				line: 8,
				party: "moq-dev/moq",
				kind: "prose",
				text: "a release ships. Review logs (recommended) before release Tag it",
			},
			problems: [],
		},
		{
			wait: {
				line: 11,
				party: "Maintainer",
				kind: "action",
				pc: false,
				text: "deploy. Back up first (recommended) to be safe",
			},
			problems: [],
		},
	]);
});

test("a draft's item that names no party stays prose, warning that a choice list needs 'Maintainer:'", () => {
	const body =
		"## Waiting\n\n- Verify the rollout.\n  - Review logs (Recommended)\n  - Confirm the release tag\n- Check these.\n  - DNS\n  - TLS\n";
	expect(handBackWaits(body)).toEqual([
		{
			line: 3,
			party: "Maintainer",
			kind: "prose",
			text: "Verify the rollout. Review logs (Recommended) Confirm the release tag",
		},
		{ line: 6, party: "Maintainer", kind: "prose", text: "Check these. DNS TLS" },
	]);
	expect(handBackProblems(body)).toEqual([
		{ line: 4, message: "a choice list needs 'Maintainer:' before its question to become a decision" },
	]);
});

test("only an item's opening names its party, never a nested choice", () => {
	const body = "## Waiting\n\n- Which API?\n  - v1: stable (Recommended)\n  - v2: faster\n";
	expect(handBackWaits(body)).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", text: "Which API? v1: stable (Recommended) v2: faster" },
	]);
	expect(handBackProblems(body)).toEqual([
		{ line: 4, message: "a choice list needs 'Maintainer:' before its question to become a decision" },
	]);
	expect(check(tree({ "a.md": `\n${body}` }), () => true).map((f) => f.line)).toEqual([9]);
});

test("check rejects a malformed choice list by line", () => {
	const docs = tree({
		"a.md":
			"\n## Waiting\n\n" +
			"- moq-dev/moq: which tag?\n  - v1 (Recommended)\n  - v2\n" +
			"- Maintainer (PC): which camera?\n  - Front (Recommended)\n  - Back\n" +
			"- Maintainer: only one?\n  - Yes (Recommended)\n" +
			"- Maintainer: two picks?\n  - Yes (Recommended)\n  - No (Recommended)\n" +
			"- Maintainer: misplaced?\n  - Yes - the (Recommended) one\n  - No (recommended)\n" +
			"- Maintainer: labels?\n  - (Recommended) - empty\n  - Same\n  - same\n" +
			"- Maintainer: two lists?\n  - A (Recommended)\n  - B\n\n  Or:\n\n  - C (Recommended)\n  - D\n" +
			"- Maintainer:\n  - E (Recommended)\n  - F\n",
	});
	expect(check(docs, () => true).map((f) => `${f.line}: ${f.message}`)).toEqual([
		"10: '## Waiting' a choice list belongs only under a plain 'Maintainer:' decision",
		"13: '## Waiting' a choice list belongs only under a plain 'Maintainer:' decision",
		"16: '## Waiting' a choice list needs at least two choices",
		"18: '## Waiting' a choice list marks exactly one choice '(Recommended)'",
		"21: '## Waiting' '(Recommended)' must end its choice's label, as 'label (Recommended) - description'",
		"24: '## Waiting' a choice needs a label",
		"26: '## Waiting' choice 'same' is listed twice",
		"33: '## Waiting' a decision holds one choice list; split the others into items of their own",
		"35: '## Waiting' a decision needs its question before its choices",
	]);
});

test("a draft's malformed choice list reads as prose, keeping a (PC) qualifier, with its problem by line", () => {
	const action = "## Waiting\n\n- Maintainer (PC): which camera?\n  - Front (Recommended)\n  - Back\n";
	expect(handBackWaits(action)).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", pc: true, text: "which camera? Front (Recommended) Back" },
	]);
	expect(waitLine(handBackWaits(action)[0])).toBe("Maintainer (PC): which camera? Front (Recommended) Back");
	// So a session away from the maintainer's computers still skips it.
	const draft = { url: "https://github.com/o/r/pull/1", branch: "fix", body: action };
	expect(waiting([], TODAY, { drafts: [draft], pc: false })).toEqual([]);
	expect(handBackProblems(action)).toEqual([
		{ line: 4, message: "a choice list belongs only under a plain 'Maintainer:' decision" },
	]);
	const unknown = "## Waiting\n\n- Maintainer (local): which runner?\n  - A (Recommended)\n  - B\n";
	expect(handBackWaits(unknown)).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", text: "Maintainer (local): which runner? A (Recommended) B" },
	]);
	// An unknown qualifier warns once, as quest check fails it once, with or without a choice list.
	const message = "'Maintainer (local)' qualifies the maintainer with neither '(action)' nor '(PC)'";
	expect(handBackProblems(unknown)).toEqual([{ line: 3, message }]);
	const login = "## Waiting\n\n- Maintainer (local): log in to codex.\n";
	expect(handBackWaits(login)).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", text: "Maintainer (local): log in to codex." },
	]);
	expect(handBackProblems(login)).toEqual([{ line: 3, message }]);
	const body = "Work.\n\n## Waiting\n\n- Maintainer: pick one.\n  - Foo (Recommended)\n  - Bar (Recommended)\n";
	expect(handBackWaits(body)).toEqual([
		{ line: 5, party: "Maintainer", kind: "prose", text: "pick one. Foo (Recommended) Bar (Recommended)" },
	]);
	expect(handBackProblems(body)).toEqual([
		{ line: 6, message: "a choice list marks exactly one choice '(Recommended)'" },
	]);
});

test("check rejects an unknown host and an empty hosts section", () => {
	const docs = tree({ "a.md": "\n## Hosts\n\n- linux\n- macos - the camera.\n- freebsd\n", "b.md": "\n## Hosts\n" });
	expect(check(docs, () => true).map((f) => `${f.path}:${f.line}: ${f.message}`)).toEqual([
		"quest/m0/a.md:11: '## Hosts' item must open with one of linux, macos, windows, optionally followed by ' - why'",
		"quest/m0/b.md:7: '## Hosts' is empty; remove the heading with its last entry",
	]);
});

test("check rejects a wait without a party and an empty section", () => {
	const docs = tree({
		"a.md": "\n## Waiting\n\n- pick a name\n- Maintainer (local): log in.\n  - A (Recommended)\n  - B\n",
		"b.md": "\n## Waiting\n",
	});
	expect(check(docs, () => true).map((f) => `${f.path}:${f.line}: ${f.message}`)).toEqual([
		"quest/m0/a.md:9: '## Waiting' item must open with who acts, as 'Maintainer: ...', 'Maintainer (action): ...' for a step only they can take, 'Maintainer (PC): ...' for one only at their computer, or '<party>: ...'",
		"quest/m0/a.md:10: '## Waiting' item must open with who acts, as 'Maintainer: ...', 'Maintainer (action): ...' for a step only they can take, 'Maintainer (PC): ...' for one only at their computer, or '<party>: ...'",
		"quest/m0/b.md:7: '## Waiting' is empty; remove the heading with its last entry",
	]);
});

test("lists the maintainer's waits first, then by milestone and impact", () => {
	const docs = tree(
		{
			"upstream.md": "\n## Waiting\n\n- moq-dev/moq: a release.\n",
			"plain.md": "",
			"later.md": "\n## Required\n\n- [Upstream](/quest/m0/upstream.md)\n",
		},
		{ "decide.md": "\n## Waiting\n\n- Maintainer: pick a provider.\n- Hetzner: verify the account.\n" },
	);
	expect(waiting(docs, TODAY)).toEqual([
		{
			path: "quest/m1/decide.md",
			pr: null,
			dependents: 0,
			ready: true,
			waits: [
				{ line: 9, party: "Maintainer", kind: "prose", text: "pick a provider." },
				{ line: 10, party: "Hetzner", kind: "prose", text: "verify the account." },
			],
		},
		{
			path: "quest/m0/upstream.md",
			pr: null,
			dependents: 1,
			ready: true,
			waits: [{ line: 9, party: "moq-dev/moq", kind: "prose", text: "a release." }],
		},
	]);
});

test("ties keep path order, as unblocked does", () => {
	const docs = tree({
		"z.md": "\n## Waiting\n\n- Maintainer: pick one.\n",
		"a.md": "\n## Waiting\n\n- Maintainer: pick another.\n",
	});
	expect(unblocked(docs, TODAY).map((quest) => quest.path)).toEqual(["quest/m0/a.md", "quest/m0/z.md"]);
	expect(waiting(docs, TODAY).map((quest) => quest.path)).toEqual(["quest/m0/a.md", "quest/m0/z.md"]);
});

test("a draft hands back with Waiting, not the retired Decisions needed heading", () => {
	expect(handedBack("Work.\n\n## Waiting\n\n- Maintainer: pick one.\n")).toBe(true);
	expect(handedBack("Work.\r\n\r\n## Decisions needed\r\n\r\n1. Pick one.\r\n")).toBe(false);
	expect(handedBack("Work.\n\n### Waiting\n\nNot a hand-back.\n")).toBe(false);
	expect(handedBack("Waiting on CI.\n")).toBe(false);
});

test("a hand-back heading inside a fence, list, or quote is an example, not a hand-back", () => {
	expect(handedBack("Docs.\n\n````markdown\n## Waiting\n\n- Maintainer: pick.\n````\n")).toBe(false);
	expect(handedBack("Docs.\n\n~~~\n## Waiting\n~~~\n")).toBe(false);
	expect(handedBack("- ## Waiting\n\n> ## Waiting\n")).toBe(false);
});

test("withoutHandBack keeps fenced examples and drops fenced text inside a hand-back", () => {
	const example = "Docs.\n\n```markdown\n## Waiting\n\n- Maintainer: pick.\n```\n\n## Validation\n\nPasses.";
	expect(withoutHandBack(example)).toBe(example);
	expect(withoutHandBack("Work.\n\n## Waiting\n\n```\n## Not a heading\n```\n\n## Validation\n\nPasses.")).toBe(
		"Work.\n\n## Validation\n\nPasses.",
	);
});

test("a draft's hand-back items are the maintainer's unless a Waiting item names its party, after any task checkbox", () => {
	expect(
		handBackWaits(
			"Work.\n\n## Waiting\n\n- Codex: out of quota until 15:00 UTC.\n- pick a name,\n  either one.\n" +
				"- [ ] Maintainer: approve the account.\n* [x] moq-dev/moq: a release.\n\n" +
				"## Validation\n\n- Passes.\n\n## Waiting\n\n1. Pick foo or bar.\n",
		),
	).toEqual([
		{ line: 5, party: "Codex", kind: "prose", text: "out of quota until 15:00 UTC." },
		{ line: 6, party: "Maintainer", kind: "prose", text: "pick a name, either one." },
		{ line: 8, party: "Maintainer", kind: "prose", text: "approve the account." },
		{ line: 9, party: "moq-dev/moq", kind: "prose", text: "a release." },
		{ line: 17, party: "Maintainer", kind: "prose", text: "Pick foo or bar." },
	]);
});

test("a draft's hand-back item keeps nested headings and the body's reference definitions, and drops raw HTML", () => {
	expect(
		handBackWaits(
			"[m]: https://example.com\n\n## Waiting\n\n- Maintainer: choose a provider.\n\n  ## Options\n\n  Hetzner or OVH.\n" +
				"- [Maintainer][m]: approve the **account**.\n- <strong>Codex</strong>: out of <!-- c -->quota.\n" +
				'- <span title="a > b">Maintainer</span>: approve.\n',
		),
	).toEqual([
		{ line: 5, party: "Maintainer", kind: "prose", text: "choose a provider. Options Hetzner or OVH." },
		{ line: 10, party: "Maintainer", kind: "prose", text: "approve the account." },
		{ line: 11, party: "Codex", kind: "prose", text: "out of quota." },
		{ line: 12, party: "Maintainer", kind: "prose", text: "approve." },
	]);
});

test("a draft's hand-back renders strikethrough and tables as GitHub does", () => {
	expect(handBackWaits("## Waiting\n\n- ~~Maintainer~~: pick.\n- Codex: ~~soon~~ later.\n")).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", text: "pick." },
		{ line: 4, party: "Codex", kind: "prose", text: "soon later." },
	]);
	expect(handBackWaits("## Waiting\n\n| when | check |\n| --- | --- |\n| 15:00 | quota |\n")).toEqual([
		{ line: 1, party: "Maintainer", kind: "prose", text: "when check 15:00 quota" },
	]);
});

test("a draft's hand-back without items is one maintainer item holding its prose", () => {
	expect(handBackWaits("Work.\r\n\r\nWaiting\r\n-------\r\n\r\nPick a name\r\nfor it.\r\n")).toEqual([
		{ line: 3, party: "Maintainer", kind: "prose", text: "Pick a name for it." },
	]);
	expect(handBackWaits("## Waiting\n\n<details>\n<summary>Why</summary>\nPick one.\n</details>\n")).toEqual([
		{ line: 1, party: "Maintainer", kind: "prose", text: "the draft hands back without saying what it waits on" },
	]);
	expect(handBackWaits("## Waiting\n\n<details>\n<summary>Why</summary>\n</details>\n\nThen merge.\n")).toEqual([
		{ line: 1, party: "Maintainer", kind: "prose", text: "Then merge." },
	]);
	expect(handBackWaits("## Waiting\n")).toEqual([
		{ line: 1, party: "Maintainer", kind: "prose", text: "the draft hands back without saying what it waits on" },
	]);
	expect(handBackWaits("Work.\n\n```\n## Waiting\n\n- Maintainer: pick.\n```\n")).toEqual([]);
});

test("drafts rank as the quest they carry, after quests on a tie, and last when they carry none", () => {
	const docs = tree(
		{ "a.md": "\n## Waiting\n\n- Maintainer: pick one.\n", "b.md": "" },
		{ "c.md": "\n## Required\n\n- [B](/quest/m0/b.md)\n" },
	);
	const draft = (url: string, branch: string, body: string) => ({ url, branch, body });
	const found = waiting(docs, TODAY, {
		drafts: [
			draft("https://example.com/pull/1", "quest-plan/x", "## Waiting\n\n- Maintainer: plan it.\n"),
			draft("https://example.com/pull/2", "quest/m0/b", "## Waiting\n\n- Maintainer: pick b.\n"),
			draft("https://example.com/pull/3", "quest/m0/a", "## Waiting\n\n- moq-dev/moq: a release.\n"),
			draft("https://example.com/pull/4", "quest/m0/a", "Ready soon.\n"),
			draft("https://example.com/pull/5", "quest/m9/gone", "## Waiting\n\n- Keep it?\n"),
		],
	});
	expect(found.map((quest) => [quest.pr ?? quest.path, quest.path, quest.dependents, quest.ready])).toEqual([
		["https://example.com/pull/2", "quest/m0/b.md", 1, true],
		["quest/m0/a.md", "quest/m0/a.md", 0, true],
		["https://example.com/pull/1", null, 0, true],
		["https://example.com/pull/5", null, 0, true],
		["https://example.com/pull/3", "quest/m0/a.md", 0, true],
	]);
});

test("waiting omits parked work's items but keeps a draft handed back for it", () => {
	const docs = (parkedReadme: boolean) => {
		const found = tree(
			{
				"parked.md": "\n## Waiting\n\n- Maintainer: pick one.\n\n## Parked\n\n- until spring\n",
				"live.md": "\n## Waiting\n\n- Maintainer: pick another.\n",
			},
			{ "later.md": "\n## Waiting\n\n- moq-dev/moq: a release.\n" },
		);
		return parkedReadme
			? found.map((doc) =>
					doc.path === "quest/m1/README.md"
						? parse(doc.path, "# m1\n\n## Goal\n\nWork.\n\n## Parked\n\n- until spring\n")
						: doc,
				)
			: found;
	};
	const draft = {
		url: "https://example.com/pull/1",
		branch: "quest/m0/parked",
		body: "## Waiting\n\n- Maintainer: plan it.\n",
	};
	for (const [milestone, listed] of [
		[false, ["quest/m0/live.md", "https://example.com/pull/1", "quest/m1/later.md"]],
		[true, ["quest/m0/live.md", "https://example.com/pull/1"]],
	] as const) {
		const found = waiting(docs(milestone), TODAY, { drafts: [draft] });
		expect(found.map((quest) => quest.pr ?? quest.path)).toEqual(listed);
		expect(found.find((quest) => quest.pr !== null)?.ready).toBe(false);
	}
	// Unparking is deleting the section: the quest's own item is listed again.
	const unparked = tree({ "parked.md": "\n## Waiting\n\n- Maintainer: pick one.\n" });
	expect(waiting(unparked, TODAY).map((quest) => quest.path)).toEqual(["quest/m0/parked.md"]);
});
