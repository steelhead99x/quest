// A quest's Markdown, rendered for its page. Quests can arrive from
// contributors' forks, so raw HTML shows as text, images as their alt text,
// and only web and mail links survive. Links into the tree open board pages.

import { Marked, type Token } from "marked";
import { resolve } from "../../../src/core/index.ts";

/** Where a quest's links go: other quests' board pages, and other files on GitHub. */
export interface Links {
	/** The board page for a quest path, or null when the tree has no such quest. */
	quest(path: string): string | null;
	/** The file on GitHub at the board's commit. */
	blob(path: string, fragment: string): string;
}

/** One `## ` section of a quest, rendered, with the id its heading's anchor links use. */
export type Section = { heading: string; id: string; html: string };

/**
 * Heading ids as GitHub makes them, so a quest's `#details` links jump on the board as on GitHub: the heading's
 * text in lower case, without punctuation but for hyphens and underscores, spaces as hyphens, and a repeat
 * numbered -1, -2, and so on through the document.
 */
export class Slugger {
	#seen = new Map<string, number>();

	slug(text: string): string {
		const base = text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
			.replace(/ /g, "-");
		const n = this.#seen.get(base);
		this.#seen.set(base, (n ?? -1) + 1);
		return n === undefined ? base : `${base}-${n + 1}`;
	}
}

/** The text a reader sees in rendered inline HTML: tags dropped, entities decoded. */
function visible(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');
}

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Where a link in `from` should point on the site, or `null` to drop it and
 * keep its text. Relative links resolve the way GitHub resolves them.
 */
export function rewrite(links: Links, from: string, href: string): string | null {
	if (/^(https?|mailto):/i.test(href)) return href;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
	if (href.startsWith("#")) return href;
	const fragment = href.indexOf("#");
	const hash = fragment < 0 ? "" : href.slice(fragment);
	const target = resolve(from, href);
	if (target === null || target === "") return null;
	const page = links.quest(target);
	return page === null ? links.blob(target, hash) : page + hash;
}

/** The document's `## ` sections in order, each rendered to HTML. The `# ` title is left to the page. */
export function render(links: Links, path: string, content: string): Section[] {
	const slugger = new Slugger();
	const marked = new Marked({
		gfm: true,
		renderer: {
			html: ({ text }) => escape(text),
			image: ({ text }) => escape(text),
			// After an inline `<code>`, `<pre>`, or `<script>` tag, marked marks the
			// following text as raw and passes it through unescaped. Raw HTML never
			// renders here, so that text is escaped like any other.
			text: (token) => ("escaped" in token && token.escaped ? escape(token.text) : false),
			link({ href, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const target = rewrite(links, path, href);
				return target === null ? inner : `<a href="${escape(target)}">${inner}</a>`;
			},
			// Section headings belong to the page; deeper ones step down below them.
			heading({ tokens, depth }) {
				const level = Math.min(depth + 1, 6);
				const inner = this.parser.parseInline(tokens);
				return `<h${level} id="${escape(slugger.slug(visible(inner)))}">${inner}</h${level}>\n`;
			},
		},
	});
	const sections: { heading: string; tokens: Token[] }[] = [];
	for (const token of marked.lexer(content)) {
		if (token.type === "heading" && token.depth === 1) continue;
		if (token.type === "heading" && token.depth === 2) {
			sections.push({ heading: token.text.trim(), tokens: [] });
		} else if (sections.length > 0) {
			sections.at(-1)!.tokens.push(token);
		} else if (token.type !== "space") {
			sections.push({ heading: "", tokens: [token] });
		}
	}
	// In document order, so a repeated heading's number matches GitHub's.
	return sections.map(({ heading, tokens }) => ({
		heading,
		id: heading ? slugger.slug(visible(marked.parseInline(heading, { async: false }))) : "",
		html: marked.parser(tokens),
	}));
}
