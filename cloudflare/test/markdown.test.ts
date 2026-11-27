// A quest's Markdown as its board page renders it.

import { expect, test } from "vitest";

import { render, Slugger } from "../src/board/markdown.ts";

const links = {
	quest: () => null,
	blob: (path: string, hash: string) => `https://github.com/o/r/blob/x/${path}${hash}`,
};

test("a link to a heading in the same quest lands on that heading", () => {
	const sections = render(
		links,
		"quest/m0/a.md",
		"# A\n\n## Goal\n\nSee [the details](#details) and [the plan's last step](#ship-it-v2).\n\n## Details\n\n### Ship it (v2)\n\nDone.\n",
	);
	const details = sections.find((s) => s.heading === "Details")!;
	expect(details.id).toBe("details");
	expect(details.html).toContain('<h4 id="ship-it-v2">Ship it (v2)</h4>');
	// The links keep their fragments, which now name ids on the page.
	expect(sections[0]!.html).toContain('href="#details"');
	expect(sections[0]!.html).toContain('href="#ship-it-v2"');
});

test("ids follow GitHub's: visible text, lower case, punctuation dropped, repeats numbered in order", () => {
	const sections = render(links, "quest/m0/a.md", "## Notes\n\n### `quest run` & caching\n\n## Notes\n\n### Notes\n");
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
