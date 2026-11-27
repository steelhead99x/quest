// Accessibility checks the demo walk runs on its pages: axe-core's WCAG 2.2 AA and best-practice rules, and
// text contrast measured directly, since the page's decorative pseudo-elements leave axe's own contrast rule
// undecided on every element.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** axe-core's browser build, to evaluate in the page before `AXE_SCRIPT`. */
export const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** A promise, as script text, of axe's violations as JSON: `[{id, impact, help, nodes: [selector]}]`. */
export const AXE_SCRIPT = `axe.run(document, {
	runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
	rules: { "color-contrast": { enabled: false } },
}).then((r) => JSON.stringify(r.violations.map((v) => ({
	id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
}))))`;

/**
 * Script text returning, as JSON, every visible text element whose contrast with the solid background behind it
 * is under WCAG AA: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). The text's and the background's pixels
 * are each composited through every ancestor, each one's opacity fading its whole group once, over the page.
 */
export const CONTRAST_SCRIPT = `(() => {
	const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
	const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
	const page = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
	const low = [];
	let checked = 0;
	const seen = new Set();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const el = walker.currentNode.parentElement;
		if (!walker.currentNode.textContent.trim() || !el || seen.has(el)) continue;
		seen.add(el);
		const s = getComputedStyle(el);
		if (s.visibility === "hidden" || !el.getClientRects().length || el.closest("[aria-hidden=true]")) continue;
		// An element's opacity fades its whole group, its background and everything inside it composited
		// together, once. So build each pixel inside out, in premultiplied colour: the text, or nothing, over
		// each element's background up the chain, each group faded by its own opacity, then over the page.
		const layers = [];
		for (let n = el; n; n = n.parentElement) {
			const ns = getComputedStyle(n);
			layers.push({ bg: parse(ns.backgroundColor), opacity: Number(ns.opacity) });
		}
		const color = parse(s.color);
		const pixel = (text) => {
			let out = text ? { r: color.r * color.a, g: color.g * color.a, b: color.b * color.a, a: color.a } : { r: 0, g: 0, b: 0, a: 0 };
			for (const { bg: c, opacity } of layers) {
				if (c && c.a > 0) {
					const k = 1 - out.a;
					out = { r: out.r + c.r * c.a * k, g: out.g + c.g * c.a * k, b: out.b + c.b * c.a * k, a: out.a + c.a * k };
				}
				out = { r: out.r * opacity, g: out.g * opacity, b: out.b * opacity, a: out.a * opacity };
			}
			const k = 1 - out.a;
			return { r: out.r + page.r * k, g: out.g + page.g * k, b: out.b + page.b * k, a: 1 };
		};
		const fg = pixel(true);
		const bg = pixel(false);
		const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
		const ratio = (hi + 0.05) / (lo + 0.05);
		const size = parseFloat(s.fontSize);
		const need = size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
		checked++;
		if (ratio < need) low.push({ text: walker.currentNode.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, need });
	}
	return JSON.stringify({ checked, low });
})()`;

/**
 * Script text planting texts the contrast check must flag, one faint and one in an opaque card inside a faded
 * wrapper, and one it must pass, then removing them: returns, as JSON, the planted texts it flagged.
 */
export const CONTRAST_CONTROL = `(() => {
	const faint = document.createElement("p");
	faint.textContent = "control: faint text";
	faint.style.color = "#334155";
	// The fade is above the card's opaque background, where a check that stops at it misses it.
	const wrapper = document.createElement("div");
	wrapper.style.opacity = "0.3";
	const card = document.createElement("div");
	card.style.background = "#0f172a";
	const faded = document.createElement("p");
	faded.textContent = "control: faded card";
	faded.style.color = "#eef2f8";
	card.append(faded);
	wrapper.append(card);
	// And one that must pass: black on a white card in a 60% wrapper is about 7.5:1 once the group is faded
	// once, but about 4:1 if the fade is counted again for the text over the already faded card.
	const light = document.createElement("div");
	light.style.opacity = "0.6";
	const sheet = document.createElement("div");
	sheet.style.background = "#ffffff";
	const dark = document.createElement("p");
	dark.textContent = "control: readable in a faded card";
	dark.style.color = "#000000";
	sheet.append(dark);
	light.append(sheet);
	const host = document.querySelector("main") || document.body;
	host.prepend(faint, wrapper, light);
	try {
		return JSON.stringify(JSON.parse(${CONTRAST_SCRIPT}).low.map((l) => l.text).filter((t) => t.startsWith("control: ")));
	} finally {
		faint.remove();
		wrapper.remove();
		light.remove();
	}
})()`;
