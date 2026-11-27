// The device bench: load each page repeatedly on one device, summarize the
// timings, check the device's clock against the driver's, and compare with a
// stored baseline for that device model.

import type { DeviceInfo, Driver, Installable, Load, OfflineView } from "./driver.ts";

/** What the bench table says a page shows offline. */
const OFFLINE_CELL: Record<OfflineView, string> = {
	page: "yes",
	notice: "notice only",
	none: "no",
};
import { median, type Regression, regressions, spread, type Summary, summarize } from "./stats.ts";

/** The metrics each load reports, and the least growth that can fail a comparison. */
export const FLOORS: Record<string, number> = {
	response: 20,
	paint: 30,
	load: 30,
	wall: 30,
	worker: 5,
	// A few hundred bytes of markup is not a regression.
	bytes: 1024,
};

/** Below this battery, a device is likely to throttle mid-run. */
export const MIN_BATTERY = 20;

/** One page's results on one device. */
export interface PageReport {
	path: string;
	cold: Record<string, Summary>;
	warm: Record<string, Summary>;
	installable: Installable;
	/** Loads whose device timing and driver clock disagreed beyond their usual gap. */
	disagreements: number;
	screenshots: { dark: boolean; file: string }[];
}

/** One device's results. */
export interface DeviceReport {
	device: DeviceInfo;
	pages: PageReport[];
}

/** A stored baseline for one device model. */
export interface Baseline {
	device: DeviceInfo;
	recorded: string;
	pages: Record<string, { cold: Record<string, Summary>; warm: Record<string, Summary> }>;
}

/** The bench's options. */
export interface Options {
	urls: string[];
	runs: number;
	/** Where screenshots go, or null to skip them. */
	save: ((name: string, png: Uint8Array) => Promise<string>) | null;
}

/** Why a device's run cannot be compared or recorded, or null when it can. */
export function unfit(device: DeviceInfo): string | null {
	if (device.throttled === true) return `${device.model} reports thermal throttling; let it cool and retry`;
	if (device.battery !== null && device.battery < MIN_BATTERY)
		return `${device.model} is at ${device.battery}% battery; charge it above ${MIN_BATTERY}% and retry`;
	return null;
}

/** Run the bench on one device. */
export async function run(driver: Driver, options: Options): Promise<DeviceReport> {
	if (options.runs < 3) throw new Error("--runs must be at least 3 to estimate run-to-run spread");
	const device = await driver.info();
	const why = unfit(device);
	if (why) throw new Error(why);
	const pages: PageReport[] = [];
	for (const url of options.urls) {
		const cold: Load[] = [];
		const warm: Load[] = [];
		for (let i = 0; i < options.runs; i++) {
			cold.push(check(url, await driver.load(url, true)));
			// The warm load follows the cold one, so the cache and service worker are fresh.
			warm.push(check(url, await driver.load(url, false)));
		}
		const installable = await driver.installable(url);
		const screenshots: PageReport["screenshots"] = [];
		if (options.save)
			for (const dark of [false, true]) {
				const name = `${device.kind}-${slug(device.model)}-${slug(new URL(url).pathname)}-${dark ? "dark" : "light"}.png`;
				screenshots.push({ dark, file: await options.save(name, await driver.screenshot(url, dark)) });
			}
		pages.push({
			path: new URL(url).pathname,
			cold: metrics(cold),
			warm: metrics(warm),
			installable,
			disagreements: disagreements([...cold, ...warm]),
			screenshots,
		});
	}
	return { device, pages };
}

/** Refuse a load that did not succeed or ended elsewhere, since its timings measure some other page. */
export function check(url: string, load: Load): Load {
	if (load.status !== 200) throw new Error(`${url} answered ${load.status}, not 200`);
	if (!load.url || new URL(load.url).href !== new URL(url).href)
		throw new Error(`${url} ended at ${load.url || "an unknown page"}: is the device still signed in?`);
	return load;
}

/** Each metric's summary over the loads, leaving out ones a browser did not report. */
export function metrics(loads: Load[]): Record<string, Summary> {
	const out: Record<string, Summary> = {};
	for (const key of Object.keys(FLOORS) as (keyof Load)[]) {
		const values = loads.map((l) => l[key]).filter((v): v is number => typeof v === "number");
		if (values.length === loads.length) out[key] = summarize(values);
	}
	return out;
}

/**
 * Count loads where the driver's clock and the page's own load time disagree
 * beyond their usual gap. The gap is the protocol's round trip, so it is
 * steady; a load far off it means one of the two clocks is wrong.
 */
export function disagreements(loads: Load[]): number {
	const gaps = loads.map((l) => l.wall - l.load);
	const m = median(gaps);
	const allowed = Math.max(4 * spread(gaps), 50);
	return gaps.filter((g) => Math.abs(g - m) > allowed).length;
}

/** The baseline file a device's results compare against. */
export function baselineName(device: DeviceInfo): string {
	return `${device.kind}-${slug(device.model)}.json`;
}

/** A baseline of this report. */
export function baseline(report: DeviceReport, recorded: string): Baseline {
	return {
		device: report.device,
		recorded,
		pages: Object.fromEntries(report.pages.map((p) => [p.path, { cold: p.cold, warm: p.warm }])),
	};
}

/** Each page's regressions against the baseline, refusing one from a different browser or OS. */
export function compare(
	base: Baseline,
	report: DeviceReport,
): { path: string; phase: string; regression: Regression }[] {
	if (base.device.os !== report.device.os || base.device.browser !== report.device.browser)
		throw new Error(
			`the baseline was recorded on ${base.device.os}, ${base.device.browser}; this device runs ${report.device.os}, ${report.device.browser}. Record a new baseline.`,
		);
	const out: { path: string; phase: string; regression: Regression }[] = [];
	for (const page of report.pages) {
		const was = base.pages[page.path];
		if (!was) continue;
		for (const phase of ["cold", "warm"] as const)
			for (const regression of regressions(was[phase], page[phase], FLOORS))
				out.push({ path: page.path, phase, regression });
	}
	return out;
}

/** The report as Markdown for a PR's `## Validation`. */
export function markdown(
	reports: DeviceReport[],
	failed: { path: string; phase: string; regression: Regression }[] | null,
) {
	const lines: string[] = [];
	const ms = (s: Summary | undefined) => (s ? `${Math.round(s.median)} / ${Math.round(s.p95)} ms` : "n/a");
	for (const { device, pages } of reports) {
		lines.push(
			`Device bench on ${device.model}, ${device.os}, ${device.browser}` +
				(device.battery === null ? "" : `, ${device.battery}% battery`) +
				`, ${pages[0]?.cold.load?.runs ?? 0} runs each (median / p95):`,
			"",
			"| Page | Load | Cold load | Warm load | Worker | Bytes | Install | Offline | Clock checks |",
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		for (const p of pages)
			lines.push(
				`| \`${p.path}\` | first paint ${ms(p.cold.paint)} | ${ms(p.cold.load)} | ${ms(p.warm.load)} | ${ms(p.cold.worker)} | ${Math.round(p.cold.bytes?.median ?? 0)} | ${installs(p.installable) ? "yes" : `no (${[...p.installable.errors, ...(p.installable.serviceWorker ? [] : ["no service worker"])].join(", ") || "no manifest"})`} | ${OFFLINE_CELL[p.installable.offline]} | ${p.disagreements === 0 ? "agree" : `${p.disagreements} disagree`} |`,
			);
		for (const limit of device.limits) lines.push("", `- Not measured: ${limit}`);
		lines.push("");
	}
	if (failed === null) lines.push("No baseline comparison was run.");
	else if (failed.length) {
		lines.push("Regressions against the stored baseline:", "");
		for (const { path, phase, regression: r } of failed)
			lines.push(
				r.kind === "slower"
					? `- \`${path}\` ${phase} ${r.metric}: ${Math.round(r.baseline)} to ${Math.round(r.current)} (allowed +${Math.round(r.allowed)})`
					: `- \`${path}\` ${phase} ${r.metric}: runs spread ${Math.round(r.current)} against the baseline's ${Math.round(r.baseline)} (allowed ${Math.round(r.allowed)}); too noisy to judge, rerun the bench`,
			);
	} else lines.push("No regressions in the baselines compared.");
	return lines.join("\n") + "\n";
}

/** Whether the browser would offer to install the page: a manifest, a service worker, and no errors. */
export function installs(i: Installable): boolean {
	return i.manifest && i.serviceWorker && i.errors.length === 0;
}

/** A file-name-safe form of `text`. */
export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "root"
	);
}
