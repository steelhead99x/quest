// Walk the demo end to end in a real Chrome: sign in, the board, a quest's CI,
// a re-run, a dispatch, the bench, installing and opening offline, and signing
// out, at a phone's size. Each step asserts what the page shows and saves a
// screenshot. Run `bun run demo` first, then:
//
//   bun demo/e2e.ts [--url http://localhost:8790] [--out ../.tmp/demo] [--chrome google-chrome]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONTROLLED_SCRIPT, OFFLINE_NOTICE_SCRIPT } from "../device/driver.ts";
import { AXE_SCRIPT, AXE_SOURCE, CONTRAST_SCRIPT } from "./a11y.ts";
import { Offline } from "../device/offline.ts";
import { Rpc } from "../device/rpc.ts";
import { sleep } from "../device/shell.ts";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://localhost:8790" },
		out: { type: "string", default: join(import.meta.dir, "..", "..", ".tmp", "demo") },
		chrome: { type: "string", default: "google-chrome" },
		port: { type: "string", default: "9231" },
	},
	strict: true,
});
const base = values.url.replace(/\/$/, "");
const port = Number(values.port);
mkdirSync(values.out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "quest-demo-chrome-"));
const chrome = Bun.spawn(
	[
		values.chrome,
		"--headless=new",
		"--no-sandbox",
		"--no-first-run",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"about:blank",
	],
	{ stdout: "ignore", stderr: "ignore" },
);

/** Every path any cache holds, read in the page. */
const KEPT = `caches.keys().then((names) => Promise.all(names.map((n) => caches.open(n).then((c) => c.keys())))).then((lists) => lists.flat().map((r) => new URL(r.url).pathname))`;

const results: { step: string; ok: boolean; detail: string; ms: number }[] = [];
let page: Rpc | null = null;

try {
	page = await connect();
	await page.call("Page.enable");
	await page.call("Network.enable");
	// An iPhone-sized screen, as the site is meant for phones.
	await page.call("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: true,
	});

	await step("Home page offers sign-in", "01-home", async () => {
		await go(`${base}/`);
		await expectText("Sign in with GitHub");
		await expectText("Install the App");
	});

	await step("Signing in returns to the home page with the App's repositories", "02-repositories", async () => {
		await act(`document.querySelector('a[href="/sign-in?next=%2F"]').click()`);
		await expectPath("/");
		await expectText("Repositories");
		const listed = await value<number>(`document.querySelectorAll('a[href="/repos/steelhead99x/quest"]').length`);
		if (listed !== 1) throw new Error("the App's repository is not listed");
	});

	await step("The board shows stats, ready quests, waiting items, CI, and workflows", "03-board", async () => {
		await act(`document.querySelector('a[href="/repos/steelhead99x/quest"]').click()`);
		await expectPath("/repos/steelhead99x/quest");
		for (const text of ["Ready to start", "Waiting", "CI on main", "Run a workflow on main", "In review"])
			await expectText(text);
		const width = await value<number>("document.documentElement.scrollWidth");
		if (width > 390) throw new Error(`the board is ${width} px wide on a 390 px screen`);
	});

	await step("A claimed quest's page shows its PR's checks and runs", "04-quest", async () => {
		const href = await value<string>(
			`[...document.querySelectorAll(".entry")].find((e) => e.textContent.includes("In review")).querySelector("a.entry-title").getAttribute("href")`,
		);
		await go(base + href);
		await expectText("CI");
		await expectText("Re-run failed jobs");
		await expectText("Approve it on GitHub");
	});

	await step("Re-running a failed run's jobs starts it, and the page shows it running", "05-rerun", async () => {
		await act(`document.querySelector('form[action*="/rerun"] button').click()`);
		await expectText("Re-run started");
		await act(`document.querySelector('a[href^="/repos/steelhead99x/quest/quest/"]').click()`);
		await expectText("Running");
		const buttons = await value<number>(`document.querySelectorAll('form[action*="/rerun"]').length`);
		if (buttons !== 0) throw new Error(`${buttons} re-run buttons remain after the re-run`);
	});

	await step("Dispatching a workflow queues a run on main", "06-dispatch", async () => {
		await go(`${base}/repos/steelhead99x/quest`);
		await value(`document.querySelector("details.ci").open = true`);
		const name = await value<string>(
			`document.querySelector('form[action$="/dispatch"]').closest(".entry").querySelector(".entry-title").textContent`,
		);
		await act(`document.querySelector('form[action$="/dispatch"] button').click()`);
		await expectText("Workflow started");
		await go(`${base}/repos/steelhead99x/quest`);
		await expectText("queued");
		await expectText(name);
	});

	await step("The bench page rolls merged quests up by size and writer", "07-bench", async () => {
		await act(`document.querySelector('a[href$="/bench"]').click()`);
		await expectPath("/repos/steelhead99x/quest/bench");
		await expectText("By size");
		await expectText("By writer");
		const rows = await value<number>(`document.querySelectorAll(".entry").length`);
		if (rows !== 5) throw new Error(`the bench lists ${rows} merged quests, not 5`);
	});

	await step(
		"The site installs to the home screen and its service worker controls it",
		"08-installable",
		async () => {
			await go(`${base}/repos/steelhead99x/quest`);
			const controlled = await value<boolean>(CONTROLLED_SCRIPT, true);
			if (!controlled) throw new Error("no service worker controls the page");
			const manifest = (await page!.call("Page.getAppManifest")) as { url?: string; errors?: unknown[] };
			const install = (await page!.call("Page.getInstallabilityErrors")) as {
				installabilityErrors?: { errorId: string }[];
			};
			if (!manifest.url || manifest.errors?.length)
				throw new Error(`manifest problems: ${JSON.stringify(manifest.errors)}`);
			const errors = install.installabilityErrors?.map((e) => e.errorId) ?? [];
			if (errors.length) throw new Error(`Chrome would not install it: ${errors.join(", ")}`);
		},
	);

	await step("Offline, a signed-in page shows the offline notice, never a kept copy", "09-offline", async () => {
		// The page's offline switch leaves its service worker online, so switch the worker too.
		const workers = await Offline.attach(port, 15_000);
		if (workers.workers === 0) throw new Error("no service worker to take offline");
		await page!.call("Network.emulateNetworkConditions", {
			offline: true,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
		});
		await workers.set(true);
		try {
			await go(`${base}/repos/steelhead99x/quest`);
			await expectText("You're offline");
			// The device bench tells the notice from the page asked for by this mark.
			if ((await value<boolean>(OFFLINE_NOTICE_SCRIPT)) !== true)
				throw new Error("the offline notice doesn't mark itself for the device bench");
			const body = await value<string>("document.body.innerText");
			if (body.includes("Ready to start")) throw new Error("the board's private content was served offline");
			const kept = await value<string[]>(KEPT, true);
			const leaked = kept.filter((path) => path.startsWith("/repos/"));
			if (leaked.length) throw new Error(`signed-in pages are cached: ${leaked.join(", ")}`);
		} finally {
			await workers.set(false);
			workers.close();
			await page!.call("Network.emulateNetworkConditions", {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
		}
	});

	await step(
		"Every page passes axe's WCAG 2.2 AA rules and text contrast, in light and dark",
		"10-accessible",
		async () => {
			await go(`${base}/repos/steelhead99x/quest`);
			const review = await value<string>(
				`[...document.querySelectorAll(".entry")].find((e) => e.textContent.includes("In review")).querySelector("a.entry-title").getAttribute("href")`,
			);
			const problems: string[] = [];
			let checked = 0;
			for (const path of [
				"/",
				"/repos/steelhead99x/quest",
				review,
				"/repos/steelhead99x/quest/bench",
				"/offline",
			])
				for (const scheme of ["light", "dark"]) {
					await page!.call("Emulation.setEmulatedMedia", {
						features: [{ name: "prefers-color-scheme", value: scheme }],
					});
					await go(base + path);
					await value(AXE_SOURCE);
					for (const v of JSON.parse(await value<string>(AXE_SCRIPT, true)) as {
						id: string;
						nodes: string[];
					}[])
						problems.push(`${path} (${scheme}): ${v.id} at ${v.nodes.join(", ")}`);
					const contrast = JSON.parse(await value<string>(CONTRAST_SCRIPT)) as {
						checked: number;
						low: { text: string; ratio: number; need: number }[];
					};
					checked += contrast.checked;
					for (const l of contrast.low)
						problems.push(`${path} (${scheme}): "${l.text}" has contrast ${l.ratio}:1, under ${l.need}:1`);
				}
			await page!.call("Emulation.setEmulatedMedia", { features: [] });
			if (checked === 0) throw new Error("no text was checked for contrast");
			if (problems.length) throw new Error(problems.slice(0, 5).join("; "));
		},
	);

	await step("Signing out drops the session and the cached pages", "11-signed-out", async () => {
		await go(`${base}/`);
		await act(`document.querySelector('form[action="/sign-out"] button').click()`);
		await expectPath("/");
		await expectText("Sign in with GitHub");
		const cookies = (await page!.call("Network.getCookies")) as { cookies: { name: string }[] };
		if (cookies.cookies.some((c) => c.name === "__Host-quest-session"))
			throw new Error("the session cookie survived");
		const kept = await value<string[]>(KEPT, true);
		const leaked = kept.filter((path) => path.startsWith("/repos/"));
		if (leaked.length) throw new Error(`cached signed-in pages: ${leaked.join(", ")}`);
	});
} finally {
	page?.close();
	chrome.kill();
	await chrome.exited;
	rmSync(profile, { recursive: true, force: true });
}

const lines = [
	`Demo end to end at ${base}, Chrome headless at 390 x 844:`,
	"",
	"| Step | Result | ms |",
	"| --- | --- | --- |",
	...results.map((r) => `| ${r.step} | ${r.ok ? "pass" : `FAIL: ${r.detail}`} | ${r.ms} |`),
	"",
	`Screenshots in ${values.out}.`,
];
console.log(lines.join("\n"));
writeFileSync(join(values.out, "report.md"), lines.join("\n") + "\n");
if (results.some((r) => !r.ok) || results.length < 11) process.exit(1);

async function connect(): Promise<Rpc> {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
			if (res.ok)
				return Rpc.connect(
					((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl,
					15_000,
				);
		} catch {
			// Chrome is still starting.
		}
		await sleep(200);
	}
	throw new Error(`Chrome did not open its DevTools port ${port}`);
}

/** Run one step: stop at its first failure, and screenshot the page either way. */
async function step(name: string, shot: string, body: () => Promise<void>) {
	const start = performance.now();
	try {
		await body();
		results.push({ step: name, ok: true, detail: "", ms: Math.round(performance.now() - start) });
	} catch (error) {
		results.push({
			step: name,
			ok: false,
			detail: (error as Error).message,
			ms: Math.round(performance.now() - start),
		});
	}
	const png = (await page!.call("Page.captureScreenshot", { format: "png" })) as { data: string };
	writeFileSync(join(values.out, `${shot}.png`), Buffer.from(png.data, "base64"));
	if (!results.at(-1)!.ok) throw new Error(`${name}: ${results.at(-1)!.detail}`);
}

/** Navigate and wait for load. */
async function go(url: string, reload = false) {
	const loaded = page!.event("Page.loadEventFired");
	if (reload) await page!.call("Page.reload", { ignoreCache: true });
	else await page!.call("Page.navigate", { url });
	await loaded;
}

/** Run a script that navigates, such as a click, and wait for the next page. */
async function act(script: string) {
	const loaded = page!.event("Page.loadEventFired");
	await value(script);
	await loaded;
}

async function value<T>(expression: string, awaitPromise = false): Promise<T> {
	const out = (await page!.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as {
		result?: { value?: T };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	};
	if (out.exceptionDetails)
		throw new Error(`the page threw: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
	return out.result?.value as T;
}

async function expectText(text: string) {
	const body = await value<string>("document.body.innerText");
	if (!body.toLowerCase().includes(text.toLowerCase())) throw new Error(`the page does not say "${text}"`);
}

async function expectPath(path: string) {
	const at = await value<string>("location.pathname");
	if (at !== path) throw new Error(`landed on ${at}, not ${path}`);
}
