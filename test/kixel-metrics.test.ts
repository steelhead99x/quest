// scripts/kixel-metrics.ts: a `quest run --report` directory merged into the root reports Kixel Quest reads.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { mergeReports } from "../scripts/kixel-metrics";
import { tempDir } from "./fixture";

function reports(files: Record<string, string>): string {
	const dir = tempDir();
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

const sample = (value: number) => ({ metrics: { bench: { latency: { value } } } });

test("a missing or empty report directory merges into nothing", () => {
	const none = { junit: null, metrics: null, problems: [] };
	expect(mergeReports(join(tempDir(), "none"))).toEqual(none);
	expect(mergeReports(reports({ "lint/out.txt": "" }))).toEqual(none);
});

test("tasks' and crates' suites merge under one root, each test's class led by the task that ran it", () => {
	const dir = reports({
		"test/b/junit.xml": [
			`﻿<?xml version="1.0"?>`,
			`<!-- nextest -->`,
			`<testsuites name="b" tests="2">`,
			`  <testsuite name="b"><testcase name="y" classname='b::m'/><system-out><![CDATA[<testcase name="z"/>]]></system-out></testsuite>`,
			`</testsuites>`,
			`<!-- done -->`,
		].join("\n"),
		"test/a/junit.xml": `<testsuite name="a"><testcase name="x" time="1"></testcase></testsuite>`,
		"lint/junit.xml": `<testsuite name=""><testcase name="w"/></testsuite>`,
		"empty/junit.xml": `<testsuites/>`,
	});
	expect(mergeReports(dir)).toEqual({
		junit: [
			`<?xml version="1.0" encoding="UTF-8"?>`,
			`<testsuites>`,
			`<testsuite name=""><testcase name="w" classname="lint"/></testsuite>`,
			`<testsuite name="a"><testcase name="x" time="1" classname="test/a/a"></testcase></testsuite>`,
			`<testsuite name="b"><testcase name="y" classname="test/b/b::m"/><system-out><![CDATA[<testcase name="z"/>]]></system-out></testsuite>`,
			`</testsuites>`,
			``,
		].join("\n"),
		metrics: null,
		problems: [],
	});
});

test("metrics merge units and concatenate samples", () => {
	const dir = reports({
		"a/metrics.json": JSON.stringify({ units: { latency: "ns" }, samples: [sample(1)] }),
		"b/x/metrics.json": JSON.stringify({ units: { latency: "ns", size: "B" }, samples: [sample(2)] }),
	});
	expect(mergeReports(dir).metrics).toEqual({ units: { latency: "ns", size: "B" }, samples: [sample(1), sample(2)] });
});

test("a report Kixel Quest would refuse, or whose units clash, is left out and named, keeping the rest", () => {
	const dir = reports({
		"a/metrics.json": JSON.stringify({ units: { latency: "ns" }, samples: [sample(1)] }),
		"b/metrics.json": JSON.stringify({ units: { latency: "ms", size: "B" }, samples: [sample(2)] }),
		"c/metrics.json": '{"units": {',
		"d/metrics.json": "{}",
		"e/junit.xml": "<report/>",
		"f/junit.xml": "<testsuites><testsuite/>",
		"g/junit.xml": `<testsuite name="g"/>`,
	});
	const merged = mergeReports(dir);
	expect(merged.metrics).toEqual({ units: { latency: "ns" }, samples: [sample(1)] });
	expect(merged.junit).toContain(`<testsuite name="g"/>`);
	expect(merged.problems).toEqual([
		"e/junit.xml: the root is neither <testsuites> nor <testsuite>",
		"f/junit.xml: <testsuites> is not closed at the end",
		"b/metrics.json: latency is in ms here but ns in another report",
		expect.stringMatching(/^c\/metrics\.json: not JSON: /),
		"d/metrics.json: units must be an object",
	]);
});
