// Merge a `quest run --report` directory into the one junit.xml and metrics.json at an artifact's root, which is
// all Kixel Quest reads of a `kixel-metrics` artifact. platform.yml runs it before uploading.
//
//   bun scripts/kixel-metrics.ts <report-dir> <out-dir>
//
// It writes what every valid report holds, then exits 1 naming each report it left out.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The merged reports, each null when no task wrote a valid one, and why each report left out was. */
export type Merged = {
	junit: string | null;
	metrics: { units: Record<string, string>; samples: unknown[] } | null;
	problems: string[];
};

/** Merge every junit.xml and metrics.json under `dir`, in path order. */
export function mergeReports(dir: string): Merged {
	const files = existsSync(dir) ? walk(dir).sort() : [];
	const problems: string[] = [];
	const suites: string[] = [];
	for (const file of files.filter((each) => each.endsWith("/junit.xml"))) {
		try {
			suites.push(junitSuites(readFileSync(join(dir, file), "utf8"), file.slice(0, -"/junit.xml".length)));
		} catch (error) {
			problems.push(`${file}: ${(error as Error).message}`);
		}
	}
	const units: Record<string, string> = {};
	const samples: unknown[] = [];
	let metrics = 0;
	for (const file of files.filter((each) => each.endsWith("/metrics.json"))) {
		const problem = addMetrics(readFileSync(join(dir, file), "utf8"), units, samples);
		if (problem === null) metrics++;
		else problems.push(`${file}: ${problem}`);
	}
	const body = suites.filter((each) => each !== "").join("\n");
	return {
		junit:
			suites.length === 0
				? null
				: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${body}\n</testsuites>\n`,
		metrics: metrics === 0 ? null : { units, samples },
		problems,
	};
}

/** Every file under `dir`, relative to it with `/` separators. */
function walk(dir: string, prefix = ""): string[] {
	return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
		const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(dir, path) : [path];
	});
}

const ATTRIBUTES = String.raw`(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*`;
/** The parts of JUnit XML a merge reads: CDATA and comments to pass over, and testsuite and testcase tags. */
const TOKEN = new RegExp(
	String.raw`<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(testsuite|testcase)\b(${ATTRIBUTES})\s*(/?)>|</testsuite\s*>`,
	"g",
);

/** The value of attribute `name` in a tag's attribute text, as written, or undefined. */
function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
	return match === null ? undefined : (match[1] ?? match[2]);
}

/**
 * The `<testsuite>` elements of one JUnit file, whose root is either `<testsuites>` or a single `<testsuite>`, with
 * each test's class led by `task`, the task or `<task>/<crate>` that ran it: Kixel Quest names a test by its class,
 * or its suite's name, and its name, so two tasks running one test stay two tests.
 */
function junitSuites(xml: string, task: string): string {
	// The prolog and epilog: a byte order mark, the XML declaration, comments, and whitespace.
	let body = xml.replace(/^﻿?(?:\s*<\?xml[^>]*\?>)?(?:\s*<!--[\s\S]*?-->)*\s*/, "").trimEnd();
	while (body.endsWith("-->") && body.includes("<!--")) body = body.slice(0, body.lastIndexOf("<!--")).trimEnd();
	if (/^<testsuites\b[^>]*\/>$/.test(body)) return "";
	const open = /^<testsuites\b[^>]*>/.exec(body);
	if (open !== null) {
		if (!body.endsWith("</testsuites>")) throw new Error("<testsuites> is not closed at the end");
		body = body.slice(open[0].length, -"</testsuites>".length).trim();
	} else if (!/^<testsuite\b/.test(body)) throw new Error("the root is neither <testsuites> nor <testsuite>");
	const lead = task.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
	const suites: string[] = [];
	return body.replace(TOKEN, (token, tag: string | undefined, attributes: string, close: string) => {
		if (tag === undefined) {
			if (token.startsWith("</")) suites.pop();
			return token;
		}
		if (tag === "testsuite") {
			if (close === "") suites.push(attribute(attributes, "name") ?? "");
			return token;
		}
		const name = (attribute(attributes, "classname") || suites.at(-1) || "").replace(/"/g, "&quot;");
		const rest = attributes.replace(/\sclassname\s*=\s*(?:"[^"]*"|'[^']*')/, "");
		return `<testcase${rest} classname="${name === "" ? lead : `${lead}/${name}`}"${close}>`;
	});
}

/** Add one metrics file's units and samples, or say why it is left out: it is malformed, or names a unit another has not. */
function addMetrics(text: string, units: Record<string, string>, samples: unknown[]): string | null {
	let metrics: { units?: unknown; samples?: unknown } | null;
	try {
		metrics = JSON.parse(text);
	} catch (error) {
		return `not JSON: ${(error as Error).message}`;
	}
	if (typeof metrics?.units !== "object" || metrics.units === null || Array.isArray(metrics.units))
		return "units must be an object";
	if (!Array.isArray(metrics.samples)) return "samples must be an array";
	const own = Object.entries(metrics.units);
	for (const [measure, unit] of own) {
		if (typeof unit !== "string") return `the unit of ${measure} must be a string`;
		if (measure in units && units[measure] !== unit)
			return `${measure} is in ${unit} here but ${units[measure]} in another report`;
	}
	for (const [measure, unit] of own) units[measure] = unit as string;
	samples.push(...metrics.samples);
	return null;
}

if (import.meta.main) {
	const [dir, out] = process.argv.slice(2);
	if (dir === undefined || out === undefined) {
		console.error("usage: bun scripts/kixel-metrics.ts <report-dir> <out-dir>");
		process.exit(2);
	}
	const merged = mergeReports(dir);
	mkdirSync(out, { recursive: true });
	if (merged.junit !== null) writeFileSync(join(out, "junit.xml"), merged.junit);
	if (merged.metrics !== null) writeFileSync(join(out, "metrics.json"), `${JSON.stringify(merged.metrics)}\n`);
	for (const problem of merged.problems) console.error(`::error::left out ${problem}`);
	process.exit(merged.problems.length === 0 ? 0 : 1);
}
