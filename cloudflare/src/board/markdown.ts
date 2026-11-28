// A quest's Markdown, rendered for its page. Quests can arrive from
// contributors' forks, so raw HTML shows as text, images as their alt text,
// and only web and mail links survive. Links into the tree open board pages.

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { Marked, Parser, type Token, type Tokens } from "marked";
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

/** A quest's page body: the id for its `# ` title, empty without one, and its sections. */
export type Rendered = { title: string; sections: Section[] };

/**
 * Heading ids as GitHub makes them, so a quest's `#details` links jump on the board as on GitHub: the heading's
 * text in lower case, without punctuation but for hyphens and underscores, spaces as hyphens, and a repeat
 * numbered -1, -2, and so on through the document, skipping any id an earlier heading already has.
 */
export class Slugger {
	#seen = new Map<string, number>();

	slug(text: string): string {
		const base = text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
			.replace(/ /g, "-");
		let id = base;
		while (this.#seen.has(id)) {
			const n = this.#seen.get(base)! + 1;
			this.#seen.set(base, n);
			id = `${base}-${n}`;
		}
		this.#seen.set(id, 0);
		return id;
	}
}

/** The text a reader sees in rendered inline HTML: tags dropped, character references decoded as HTML does. */
function visible(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&(#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/g, (ref, body: string) => {
			if (!body.startsWith("#")) return decodeNamedCharacterReference(body) || ref;
			const n = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
		});
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

/**
 * The document's `## ` sections in order, each rendered to HTML, and the id of its last `# ` heading, which the
 * page draws as its title (as `src/core/doc.ts` picks it). Every `# ` heading takes its id in document order, as on
 * GitHub.
 */
export function render(links: Links, path: string, content: string): Rendered {
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
	// From the heading's tokens as the whole document lexed them, so a reference link resolves to its text.
	const id = (heading: Tokens.Heading) => slugger.slug(visible(Parser.parseInline(heading.tokens, marked.defaults)));
	// `# ` headings outside the title stay off the page, but each holds its place in the ids' order, so what
	// follows one starts a section of its own.
	type Part = { heading?: Tokens.Heading; tokens: Token[] };
	const parts: ({ title: Tokens.Heading } | Part)[] = [];
	let open: Part | undefined;
	for (const token of marked.lexer(content)) {
		if (token.type === "heading" && token.depth === 1) {
			parts.push({ title: token as Tokens.Heading });
			open = undefined;
		} else if (token.type === "heading" && token.depth === 2) {
			parts.push((open = { heading: token as Tokens.Heading, tokens: [] }));
		} else if (open) {
			open.tokens.push(token);
		} else if (token.type !== "space") {
			parts.push((open = { tokens: [token] }));
		}
	}
	// In document order, so a repeated heading's number matches GitHub's.
	let title = "";
	const sections: Section[] = [];
	for (const part of parts) {
		if ("title" in part) title = id(part.title);
		else
			sections.push({
				heading: part.heading?.text.trim() ?? "",
				id: part.heading ? id(part.heading) : "",
				html: marked.parser(part.tokens),
			});
	}
	return { title, sections };
}
