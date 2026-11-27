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
 * is under WCAG AA: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). Opacity and translucent backgrounds
 * are blended; the page's background colour is the last layer.
 */
export const CONTRAST_SCRIPT = `(() => {
	const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
	const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
	const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
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
		let opacity = 1;
		const layers = [];
		for (let n = el; n; n = n.parentElement) {
			const ns = getComputedStyle(n);
			opacity *= Number(ns.opacity);
			const c = parse(ns.backgroundColor);
			if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
		}
		let bg = page;
		for (const layer of layers.reverse()) bg = over(layer, bg);
		const color = parse(s.color);
		const fg = over({ ...color, a: color.a * opacity }, bg);
		const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
		const ratio = (hi + 0.05) / (lo + 0.05);
		const size = parseFloat(s.fontSize);
		const need = size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
		checked++;
		if (ratio < need) low.push({ text: walker.currentNode.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, need });
	}
	return JSON.stringify({ checked, low });
})()`;
