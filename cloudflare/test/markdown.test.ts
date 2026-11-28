// A quest's Markdown as its board page renders it.

import { expect, test } from "vitest";

import { render, Slugger } from "../src/board/markdown.ts";

const links = {
	quest: () => null,
	blob: (path: string, hash: string) => `https://github.com/o/r/blob/x/${path}${hash}`,
};

test("a link to a heading in the same quest lands on that heading", () => {
	const { title, sections } = render(
		links,
		"quest/m0/a.md",
		"# A\n\n## Goal\n\nSee [the details](#details) and [the plan's last step](#ship-it-v2).\n\n## Details\n\n### Ship it (v2)\n\nDone.\n",
	);
	expect(title).toBe("a");
	const details = sections.find((s) => s.heading === "Details")!;
	expect(details.id).toBe("details");
	expect(details.html).toContain('<h4 id="ship-it-v2">Ship it (v2)</h4>');
	// The links keep their fragments, which now name ids on the page.
	expect(sections[0]!.html).toContain('href="#details"');
	expect(sections[0]!.html).toContain('href="#ship-it-v2"');
});

test("ids follow GitHub's: visible text, lower case, punctuation dropped, repeats numbered in order", () => {
	const { sections } = render(
		links,
		"quest/m0/a.md",
		"## Notes\n\n### `quest run` & caching\n\n## Notes\n\n### Notes\n",
	);
	expect(sections.map((s) => s.id)).toEqual(["notes", "notes-1"]);
	expect(sections[0]!.html).toContain('id="quest-run--caching"');
	expect(sections[1]!.html).toContain('id="notes-2"');
});

test("a heading's id is escaped, and one with only punctuation is empty but unique", () => {
	const s = new Slugger();
	expect(s.slug('a"b<c')).toBe("abc");
	expect(s.slug("!!!")).toBe("");
	expect(s.slug("???")).toBe("-1");
});

test("a repeat skips an id an earlier heading already has, as GitHub's does", () => {
	const s = new Slugger();
	expect(["Phase", "Phase-1", "Phase", "Step-1", "Step", "Step"].map((t) => s.slug(t))).toEqual([
		"phase",
		"phase-1",
		"phase-2",
		"step-1",
		"step",
		"step-2",
	]);
});

test("every `# ` heading takes its id in order, the last naming the page's title", () => {
	const { title, sections } = render(links, "quest/m0/a.md", "# Notes\n\n## Notes\n\n# Notes\n\n### Notes\n");
	expect(title).toBe("notes-2");
	expect(sections[0]!.id).toBe("notes-1");
	expect(sections[1]!.html).toContain('id="notes-3"');
	expect(render(links, "quest/m0/a.md", "## Goal\n").title).toBe("");
});

test("character references in a heading decode as HTML does, and an invalid one never throws", () => {
	const { sections } = render(
		links,
		"quest/m0/a.md",
		"## Caf&eacute; &#x41;\n\n## <https://a.example/&#99999999999;>\n\n## &bogus; &#0;\n\n## &#99999999999; x\n\n## <https://b.example/&#2000000;>\n",
	);
	expect(sections.map((s) => s.id)).toEqual([
		"café-a",
		"httpsaexample99999999999",
		"bogus-",
		"99999999999-x",
		"httpsbexample",
	]);
});

test("a heading's reference link takes its id from the link's text, its definition anywhere in the document", () => {
	const { title, sections } = render(
		links,
		"quest/m0/README.md",
		"# [Worker guide][docs]\n\n## [Plan][docs]\n\n[docs]: https://example.com/guide\n",
	);
	expect(title).toBe("worker-guide");
	expect(sections[0]!.id).toBe("plan");
});
