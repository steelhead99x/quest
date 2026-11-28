// Benchmark and validate the site on the Android phone and iPad attached to
// this computer. See cloudflare/DEVICES.md.
//
//   bun scripts/device-bench.ts --url https://quest.example.dev/ [--url ...] [--device android|ipad]...
//     [--runs 5] [--shots dir] [--record] [--android-serial S] [--ipad-udid U]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Android } from "../device/android.ts";
import {
	type Baseline,
	baseline,
	baselineName,
	compare,
	type DeviceReport,
	type Failure,
	markdown,
	run,
} from "../device/bench.ts";
import type { Driver } from "../device/driver.ts";
import { Ipad } from "../device/ipad.ts";
import { shell } from "../device/shell.ts";

const BASELINES = join(import.meta.dir, "..", "bench");
const TIMEOUT = 30_000;

const { values } = parseArgs({
	options: {
		url: { type: "string", multiple: true },
		device: { type: "string", multiple: true },
		runs: { type: "string", default: "5" },
		shots: { type: "string" },
		record: { type: "boolean", default: false },
		"android-serial": { type: "string" },
		"ipad-udid": { type: "string" },
	},
	strict: true,
});
const urls = values.url ?? [];
if (urls.length === 0) throw new Error("give at least one --url");
for (const u of urls) if (!/^https?:\/\//.test(u)) throw new Error(`--url must be http or https: ${u}`);
const devices = values.device ?? ["android", "ipad"];
for (const d of devices) if (d !== "android" && d !== "ipad") throw new Error(`--device is android or ipad: ${d}`);
const runs = Number(values.runs);
if (!Number.isInteger(runs)) throw new Error(`--runs is not a whole number: ${values.runs}`);
if (values.shots) mkdirSync(values.shots, { recursive: true });

const sh = shell();
const reports: DeviceReport[] = [];
for (const kind of devices) {
	// Every requested device must run: a missing one fails the bench rather than skipping it.
	const driver: Driver =
		kind === "android"
			? await Android.open(sh, 9223, TIMEOUT, values["android-serial"])
			: await Ipad.open(sh, 9224, TIMEOUT, values["ipad-udid"]);
	try {
		reports.push(
			await run(driver, {
				urls,
				runs,
				save: values.shots
					? async (name, png) => {
							const file = join(values.shots!, name);
							writeFileSync(file, png);
							return file;
						}
					: null,
			}),
		);
	} finally {
		await driver.close();
	}
}

const failed: Failure[] = [];
const unbaselined: { model: string; path: string }[] = [];
const uncompared: string[] = [];
const recorded: string[] = [];
for (const report of reports) {
	const file = join(BASELINES, baselineName(report.device));
	if (values.record) {
		mkdirSync(BASELINES, { recursive: true });
		// Only a page without warm timings needs the earlier baseline, so a damaged file doesn't block a full recording.
		const needs = report.pages.some((p) => Object.keys(p.warm).length === 0);
		const was = needs && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Baseline) : undefined;
		writeFileSync(file, JSON.stringify(baseline(report, new Date().toISOString(), was), null, "\t") + "\n");
		console.error(`Recorded ${file}`);
		recorded.push(report.device.model);
	} else if (existsSync(file)) {
		const found = compare(JSON.parse(readFileSync(file, "utf8")) as Baseline, report);
		failed.push(...found.regressions);
		unbaselined.push(...found.unbaselined.map((path) => ({ model: report.device.model, path })));
	} else {
		console.error(`No baseline for ${report.device.model} at ${file}; run with --record to make one.`);
		uncompared.push(report.device.model);
	}
}
process.stdout.write(markdown(reports, { failed, unbaselined, uncompared, recorded }));
if (failed.length) process.exit(1);
