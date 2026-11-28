import { afterEach, describe, expect, test } from "vitest";
import { blankTab, health, navigate, notCaptured, type Page, serial } from "../device/android.ts";
import {
	type Baseline,
	baseline,
	compare,
	disagreements,
	installs,
	markdown,
	metrics,
	run,
	slug,
	unfit,
} from "../device/bench.ts";
import { type DeviceInfo, type Driver, type Load, pageTiming } from "../device/driver.ts";
import { clearStorage, tab, Target, udid } from "../device/ipad.ts";
import { Rpc } from "../device/rpc.ts";
import { median, p95, quantile, regressions, spread, summarize } from "../device/stats.ts";

const load = (overrides: Partial<Load> = {}): Load => ({
	response: 100,
	paint: 200,
	load: 300,
	bytes: 20_000,
	worker: 12,
	status: 200,
	// Empty: the fake driver fills in the page it was asked for.
	url: "",
	wall: 340,
	...overrides,
});

const device = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
	kind: "android",
	model: "SM-A166B",
	os: "Android 16",
	browser: "Chrome/142.0",
	battery: 80,
	throttled: false,
	limits: [],
	...overrides,
});

/** A driver whose loads come from a list, so every run is deterministic. */
function fake(info: DeviceInfo, loads: Load[], controls: boolean[] = [true]): Driver & { calls: string[] } {
	const calls: string[] = [];
	let i = 0;
	let c = 0;
	return {
		calls,
		info: async () => info,
		load: async (url, cold) => {
			calls.push(`${cold ? "cold" : "warm"} ${url}`);
			const l = loads[i++ % loads.length]!;
			return { ...l, url: l.url || url };
		},
		controlled: async () => {
			calls.push("controlled");
			return controls[c++ % controls.length]!;
		},
		installable: async () => ({ manifest: true, serviceWorker: true, offline: "page" as const, errors: [] }),
		screenshot: async (_, dark) => new Uint8Array([dark ? 1 : 0]),
		close: async () => undefined,
	};
}

describe("stats", () => {
	test("quantiles interpolate between samples", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(quantile([0, 10], 0.95)).toBeCloseTo(9.5);
		expect(p95([5])).toBe(5);
	});

	test("spread ignores one outlier", () => {
		expect(spread([100, 101, 99, 100, 5000])).toBe(1);
	});

	test("refuses empty or non-finite samples", () => {
		expect(() => median([])).toThrow("no samples");
		expect(() => median([1, Number.NaN])).toThrow("finite");
	});

	test("a regression must clear both the noise and the floor", () => {
		const base = { load: summarize([300, 310, 290, 300, 305]) };
		expect(regressions(base, { load: summarize([320, 330, 310, 320, 325]) }, { load: 30 })).toEqual([]);
		expect(regressions(base, { load: summarize([400, 410, 390, 400, 405]) }, { load: 30 })).toEqual([
			{ metric: "load", kind: "slower", baseline: 300, current: 400, allowed: 30 },
		]);
	});

	test("a noisy run gets no extra room: it fails as slower, or as too noisy to judge", () => {
		// The review's case: a steady 100 ms baseline against a scattered run whose median is 250 ms.
		const steady = { load: summarize([100, 101, 99, 100, 100]) };
		const slower = regressions(steady, { load: summarize([100, 400, 250, 120, 380]) }, { load: 30 });
		expect(slower).toEqual([{ metric: "load", kind: "slower", baseline: 100, current: 250, allowed: 30 }]);
		// Same median as the baseline, but the runs scatter too widely to trust it.
		const noisy = regressions(steady, { load: summarize([100, 300, 0, 260, 50]) }, { load: 30 });
		expect(noisy).toEqual([{ metric: "load", kind: "noisy", baseline: 0, current: 100, allowed: 90 }]);
		// Ordinary jitter within the floor passes.
		expect(regressions(steady, { load: summarize([100, 120, 95, 110, 105]) }, { load: 30 })).toEqual([]);
	});

	test("refuses a run missing a metric the baseline has", () => {
		expect(() => regressions({ load: summarize([1, 2, 3]) }, {}, {})).toThrow("no load");
	});
});

describe("parsers", () => {
	test("picks the one authorized adb device", () => {
		expect(serial("List of devices attached\nR58N123\tdevice\n\n")).toBe("R58N123");
		expect(() => serial("List of devices attached\n\n")).toThrow("no Android device");
		expect(() => serial("List of devices attached\nA\tdevice\nB\tdevice\n")).toThrow("--android-serial");
		expect(serial("List of devices attached\nA\tdevice\nB\tdevice\n", "B")).toBe("B");
		expect(() => serial("List of devices attached\nA\tunauthorized\n")).toThrow("USB debugging prompt");
		expect(() => serial("List of devices attached\nA\toffline\n")).toThrow("A is offline");
	});

	test("reads battery and thermal status from dumpsys", () => {
		expect(health("  AC powered: false\n  level: 64\n", "Thermal Status: 0\n")).toEqual({
			battery: 64,
			throttled: false,
		});
		expect(health("  level: 90\n", "Thermal Status: 3\n").throttled).toBe(true);
		expect(health("", "")).toEqual({ battery: null, throttled: null });
	});

	test("picks the one attached iPad and its Safari tab", () => {
		expect(udid("00008112-0001\n")).toBe("00008112-0001");
		expect(() => udid("")).toThrow("no iPad");
		expect(() => udid("a\nb\n")).toThrow("--ipad-udid");
		expect(tab([{ title: "x" }, { webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/1" }])).toBe(
			"ws://127.0.0.1:9224/devtools/page/1",
		);
		expect(() => tab([])).toThrow("Web Inspector");
	});

	test("reads the page's timing and refuses a malformed one", () => {
		const t = { response: 1, paint: null, load: 3, bytes: 4, worker: null, status: 200, url: "https://q.dev/" };
		expect(pageTiming(JSON.stringify(t))).toEqual(t);
		expect(() => pageTiming(JSON.stringify({ ...t, load: -1 }))).toThrow("load");
		expect(() => pageTiming(JSON.stringify({ ...t, bytes: "x" }))).toThrow("bytes");
		expect(() => pageTiming(undefined)).toThrow("no timing");
	});
});

describe("bench", () => {
	test("refuses a load that ended on another page, such as GitHub's sign-in", async () => {
		const redirected = fake(device(), [load({ url: "https://github.com/login" })]);
		await expect(
			run(redirected, { urls: ["https://q.dev/repos/x"], runs: 3, save: async (n) => n }),
		).rejects.toThrow("ended at https://github.com/login");
	});

	test("the iPad's storage wipe runs only on the site's own origin", async () => {
		const wipe = async (href: string) => {
			const done: string[] = [];
			const scope = {
				location: new URL(href),
				navigator: {
					serviceWorker: { getRegistrations: async () => [{ unregister: async () => done.push("sw") }] },
				},
				caches: { keys: async () => ["pages"], delete: async (k: string) => done.push(k) },
			};
			const value = await new Function(...Object.keys(scope), "self", `return ${clearStorage("https://q.dev")}`)(
				...Object.values(scope),
				scope,
			);
			return { value, done };
		};
		expect(await wipe("https://q.dev/repos/x")).toEqual({ value: true, done: ["sw", "pages"] });
		expect(await wipe("https://github.com/login?return_to=x")).toEqual({
			value: "https://github.com/login?return_to=x",
			done: [],
		});
	});

	test("loads each page cold then warm, and saves light and dark screenshots", async () => {
		const driver = fake(device(), [load()]);
		const saved: string[] = [];
		const report = await run(driver, {
			urls: ["https://q.dev/", "https://q.dev/repos/x"],
			runs: 3,
			save: async (name) => (saved.push(name), name),
		});
		expect(driver.calls).toEqual([
			...Array(3).fill(["cold https://q.dev/", "controlled", "warm https://q.dev/"]).flat(),
			...Array(3).fill(["cold https://q.dev/repos/x", "controlled", "warm https://q.dev/repos/x"]).flat(),
		]);
		expect(saved).toEqual([
			"android-sm-a166b-root-light.png",
			"android-sm-a166b-root-dark.png",
			"android-sm-a166b-repos-x-light.png",
			"android-sm-a166b-repos-x-dark.png",
		]);
		expect(report.pages.map((p) => p.path)).toEqual(["/", "/repos/x"]);
		expect(report.pages[0]!.cold.load).toEqual({ median: 300, p95: 300, spread: 0, runs: 3 });
	});

	test("skips a warm load the service worker never took control of", async () => {
		const driver = fake(device(), [load()], [true, false, true, true]);
		const report = await run(driver, { urls: ["https://q.dev/"], runs: 4, save: null });
		expect(driver.calls.filter((call) => call.startsWith("warm"))).toHaveLength(3);
		expect(report.pages[0]!.warm.load?.runs).toBe(3);
		expect(report.pages[0]!.uncontrolled).toBe(1);
		expect(markdown([report], [])).toContain("- `/`: 1 of 4 warm loads skipped, as no service worker took control");
		// Too few warm loads to estimate spread keep the cold results, flagged, and neither compare nor record warm ones.
		const few = await run(fake(device(), [load({ load: 900 })], [true, false, true]), {
			urls: ["https://q.dev/"],
			runs: 3,
			save: null,
		});
		expect(few.pages[0]!.cold.load?.median).toBe(900);
		expect(few.pages[0]!.warm).toEqual({});
		expect(markdown([few], [])).toContain("| 900 / 900 ms | n/a |");
		expect(markdown([few], [])).toContain("too few remain to summarize");
		const base = baseline(report, "2026-11-25T00:00:00Z");
		expect(compare(base, few).map((f) => `${f.phase} ${f.regression.metric}`)).toEqual(["cold load"]);
		expect(baseline(few, "2026-11-26T00:00:00Z", base).pages["/"]!.warm).toEqual(base.pages["/"]!.warm);
		const otherBrowser = { ...few, device: { ...few.device, browser: "Chrome/143.0" } };
		expect(baseline(otherBrowser, "2026-11-26T00:00:00Z", base).pages["/"]!.warm).toEqual({});
	});

	test.each([
		["a throttled device", device({ throttled: true }), "thermal throttling"],
		["a low battery", device({ battery: 10 }), "10% battery"],
	])("refuses %s", async (_, info, message) => {
		expect(unfit(info)).toContain(message);
		await expect(run(fake(info, [load()]), { urls: ["https://q.dev/"], runs: 3, save: null })).rejects.toThrow(
			message,
		);
	});

	test("accepts a device that cannot report its health", () => {
		expect(unfit(device({ battery: null, throttled: null }))).toBeNull();
	});

	test("refuses a page that did not answer 200", async () => {
		await expect(
			run(fake(device(), [load({ status: 500 })]), { urls: ["https://q.dev/"], runs: 3, save: null }),
		).rejects.toThrow("answered 500");
	});

	test("needs three runs to estimate spread", async () => {
		await expect(run(fake(device(), [load()]), { urls: ["https://q.dev/"], runs: 2, save: null })).rejects.toThrow(
			"at least 3",
		);
	});

	test("leaves out a metric a browser did not report on every load", () => {
		expect(Object.keys(metrics([load({ paint: null }), load()]))).not.toContain("paint");
		expect(Object.keys(metrics([load(), load()]))).toContain("paint");
	});

	test("flags a load whose clocks disagree", () => {
		const steady = [load(), load({ wall: 345 }), load({ wall: 338 }), load({ wall: 342 })];
		expect(disagreements(steady)).toBe(0);
		expect(disagreements([...steady, load({ wall: 2_000 })])).toBe(1);
	});

	test("compares with a baseline and refuses another browser's", async () => {
		const base: Baseline = baseline(
			await run(fake(device(), [load()]), { urls: ["https://q.dev/"], runs: 3, save: null }),
			"2026-11-25T00:00:00Z",
		);
		const slower = await run(fake(device(), [load({ load: 900 })]), {
			urls: ["https://q.dev/"],
			runs: 3,
			save: null,
		});
		const found = compare(base, slower);
		expect(found.map((f) => `${f.phase} ${f.regression.metric}`)).toEqual(["cold load", "warm load"]);
		expect(markdown([slower], found)).toContain("`/` cold load: 300 to 900 (allowed +30)");
		const other = await run(fake(device({ browser: "Chrome/143.0" }), [load()]), {
			urls: ["https://q.dev/"],
			runs: 3,
			save: null,
		});
		expect(() => compare(base, other)).toThrow("Record a new baseline");
	});

	test("reports each page and what a device could not measure", async () => {
		const report = await run(
			fake(device({ kind: "ipad", model: "iPad16,1", limits: ["text size: by hand"] }), [load()]),
			{
				urls: ["https://q.dev/"],
				runs: 3,
				save: null,
			},
		);
		const md = markdown([report], []);
		expect(md).toContain(
			"| `/` | first paint 200 / 200 ms | 300 / 300 ms | 300 / 300 ms | 12 / 12 ms | 20000 | yes | yes | agree |",
		);
		expect(md).toContain("- Not measured: text size: by hand");
		expect(md).toContain("No regressions");
		expect(markdown([report], [], [report.device.model])).toContain("No baseline comparison was run.");
		// With two devices and one baseline, the report names the one that wasn't compared.
		const other = { ...report, device: { ...report.device, model: "iPad Air" } };
		const partly = markdown([report, other], [], ["iPad Air"]);
		expect(partly).toContain("Not compared, with no stored baseline: iPad Air.");
		expect(partly).toContain("No regressions in the baselines compared.");
		// --record compares nothing, and says the baseline now exists.
		const recorded = markdown([report], [], [], [report.device.model]);
		expect(recorded).toContain(`Recorded a baseline for ${report.device.model}`);
		expect(recorded).not.toContain("no stored baseline");
		expect(recorded).toContain("No baseline comparison was run.");
		// A page that opens offline only as the site's notice doesn't count as opening offline.
		const pages = report.pages.map((p) => ({
			...p,
			installable: { ...p.installable, offline: "notice" as const },
		}));
		const notice = markdown([{ ...report, pages }], []);
		expect(notice).toContain("| yes | notice only | agree |");
	});

	test("a browser's installability error means the page does not install", () => {
		const ok = { manifest: true, serviceWorker: true, offline: "page" as const, errors: [] };
		expect(installs(ok)).toBe(true);
		expect(installs({ ...ok, errors: ["no-acceptable-icon"] })).toBe(false);
		expect(installs({ ...ok, serviceWorker: false })).toBe(false);
	});

	test("slugs keep file names safe", () => {
		expect(slug("/repos/moq-dev/quest")).toBe("repos-moq-dev-quest");
		expect(slug("/")).toBe("root");
		expect(slug("../../etc")).toBe("etc");
	});
});

describe("android", () => {
	test("benchmarks only the blank tab adb opened, never one of the person's pages", () => {
		const ws = "ws://127.0.0.1:9222/devtools/page/2";
		expect(
			blankTab([
				{ type: "page", url: "https://mail.example/", webSocketDebuggerUrl: "ws://x/1" },
				{ type: "service_worker", url: "about:blank", webSocketDebuggerUrl: "ws://x/sw" },
				{ type: "page", url: "about:blank", webSocketDebuggerUrl: ws },
			]),
		).toBe(ws);
		// Another client already attached to the blank tab leaves it without a socket.
		expect(() => blankTab([{ type: "page", url: "about:blank" }])).toThrow("no debuggable blank tab");
		expect(() => blankTab([])).toThrow("unlock the phone");
	});

	test("refuses a screenshot of a redirect, saying where it went", () => {
		const url = "https://quest.example/repos/o/r";
		expect(notCaptured(url, { url, status: 200 })).toBeNull();
		expect(notCaptured(url, { url: "https://quest.example/?signed-out", status: 200 })).toContain(
			"redirected to https://quest.example/?signed-out; sign the phone's Chrome in",
		);
		expect(notCaptured(url, { url, status: 500 })).toBe(`Chrome could not capture ${url}: HTTP 500`);
	});

	/** A page whose navigations answer `errors` in turn, then load. */
	function fakePage(errors: (string | undefined)[]) {
		const navigations: string[] = [];
		const page: Page = {
			call: (async (method: string, params?: Record<string, unknown>) => {
				if (method !== "Page.navigate") return {};
				navigations.push(String(params?.url));
				const errorText = errors.shift();
				return errorText ? { errorText } : {};
			}) as Page["call"],
			event: (async () => ({ method: "Page.loadEventFired", params: {} })) as Page["event"],
		};
		return { page, navigations };
	}
	const timing = async () => ({ url: "https://quest.example/", status: 200 }) as unknown as Omit<Load, "wall">;

	test("retries one aborted navigation and times only the load that worked", async () => {
		const { page, navigations } = fakePage(["net::ERR_ABORTED"]);
		const load = await navigate(page, "https://quest.example/", timing);
		expect(navigations).toEqual(["https://quest.example/", "https://quest.example/"]);
		expect(load.status).toBe(200);
		// The 500 ms pause before the retry is outside the timed attempt.
		expect(load.wall).toBeLessThan(400);
	});

	test("gives up after a second abort, and never retries other errors", async () => {
		const twice = fakePage(["net::ERR_ABORTED", "net::ERR_ABORTED"]);
		await expect(navigate(twice.page, "https://quest.example/", timing)).rejects.toThrow("net::ERR_ABORTED");
		expect(twice.navigations).toHaveLength(2);
		const dns = fakePage(["net::ERR_NAME_NOT_RESOLVED"]);
		await expect(navigate(dns.page, "https://quest.example/", timing)).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
		expect(dns.navigations).toHaveLength(1);
	});
});

describe("rpc", () => {
	const servers: { stop(force?: boolean): void }[] = [];
	afterEach(() => {
		for (const s of servers.splice(0)) s.stop(true);
	});

	/** A WebSocket server answering each call with `reply`, which may also send events. */
	function serve(
		reply: (
			msg: { id: number; method: string; params: Record<string, unknown> },
			send: (m: unknown) => void,
		) => void,
	) {
		const server = Bun.serve({
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
			websocket: {
				message: (ws, data) => reply(JSON.parse(String(data)), (m) => ws.send(JSON.stringify(m))),
			},
		});
		servers.push(server);
		return `ws://127.0.0.1:${server.port}`;
	}

	test("matches answers to calls and surfaces protocol errors", async () => {
		const url = serve((m, send) =>
			m.method === "Bad.call"
				? send({ id: m.id, error: { message: "no such method" } })
				: send({ id: m.id, result: { echo: m.params } }),
		);
		const rpc = await Rpc.connect(url, 2_000);
		const [a, b] = await Promise.all([rpc.call("A.x", { n: 1 }), rpc.call("B.y", { n: 2 })]);
		expect(a).toEqual({ echo: { n: 1 } });
		expect(b).toEqual({ echo: { n: 2 } });
		await expect(rpc.call("Bad.call")).rejects.toThrow("no such method");
		rpc.close();
	});

	test("times out a call nobody answers", async () => {
		const rpc = await Rpc.connect(
			serve(() => undefined),
			100,
		);
		await expect(rpc.call("Never.answered")).rejects.toThrow("no answer within 100 ms");
		rpc.close();
	});

	test("waits for a matching event", async () => {
		const url = serve((m, send) => {
			send({ method: "Page.loadEventFired", params: { n: 1 } });
			send({ method: "Page.loadEventFired", params: { n: 2 } });
			send({ id: m.id, result: {} });
		});
		const rpc = await Rpc.connect(url, 2_000);
		const second = rpc.event("Page.loadEventFired", (p) => p.n === 2);
		await rpc.call("Page.navigate");
		expect((await second).params).toEqual({ n: 2 });
		rpc.close();
	});

	test("fails pending calls when the device drops the connection", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
			websocket: { message: (ws) => ws.close() },
		});
		servers.push(server);
		const rpc = await Rpc.connect(`ws://127.0.0.1:${server.port}`, 2_000);
		await expect(rpc.call("Any.call")).rejects.toThrow("closed");
		await expect(rpc.call("After.close")).rejects.toThrow("closed");
	});

	test("refuses a non-JSON message", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
			websocket: { message: (ws) => void ws.send("not json") },
		});
		servers.push(server);
		const rpc = await Rpc.connect(`ws://127.0.0.1:${server.port}`, 2_000);
		await expect(rpc.call("Any.call")).rejects.toThrow("not JSON");
	});

	test("routes calls through a WebKit page target and back", async () => {
		const url = serve((m, send) => {
			if (m.method !== "Target.sendMessageToTarget") return send({ id: m.id, error: { message: "not wrapped" } });
			send({ id: m.id, result: {} });
			const inner = JSON.parse(String(m.params.message)) as { id: number; method: string };
			send({ method: "Target.dispatchMessageFromTarget", params: { targetId: "other", message: "{}" } });
			send({
				method: "Target.dispatchMessageFromTarget",
				params: { targetId: "page-1", message: JSON.stringify({ method: "Page.loadEventFired", params: {} }) },
			});
			send({
				method: "Target.dispatchMessageFromTarget",
				params: {
					targetId: "page-1",
					message: JSON.stringify({ id: inner.id, result: { method: inner.method } }),
				},
			});
		});
		const rpc = await Rpc.connect(url, 2_000);
		const page = new Target(rpc, "page-1", 2_000);
		const loaded = page.event("Page.loadEventFired");
		expect(await page.call("Runtime.evaluate", { expression: "1" })).toEqual({ method: "Runtime.evaluate" });
		await loaded;
		rpc.close();
	});

	test("follows a WebKit page target across a cross-process navigation", async () => {
		const sentTo: string[] = [];
		const url = serve((m, send) => {
			send({ id: m.id, result: {} });
			const target = String(m.params.targetId);
			const inner = JSON.parse(String(m.params.message)) as { id: number; method: string };
			sentTo.push(`${target} ${inner.method}`);
			const reply = (from: string, message: unknown) =>
				send({
					method: "Target.dispatchMessageFromTarget",
					params: { targetId: from, message: JSON.stringify(message) },
				});
			if (inner.method === "Page.navigate") {
				reply(target, { id: inner.id, result: {} });
				send({
					method: "Target.targetCreated",
					params: { targetInfo: { targetId: "page-2", type: "page", isProvisional: true } },
				});
				setTimeout(() => {
					send({
						method: "Target.didCommitProvisionalTarget",
						params: { oldTargetId: "page-1", newTargetId: "page-2" },
					});
					reply("page-2", { method: "Page.loadEventFired", params: {} });
				}, 30);
			} else reply(target, { id: inner.id, result: { at: target } });
		});
		const rpc = await Rpc.connect(url, 2_000);
		const page = new Target(rpc, "page-1", 2_000);
		await page.call("Page.enable");
		const loaded = page.event("Page.loadEventFired");
		await page.call("Page.navigate", { url: "https://q.dev/" });
		await loaded;
		expect(page.current).toBe("page-2");
		expect(sentTo).toContain("page-2 Page.enable");
		expect(await page.call("Runtime.evaluate")).toEqual({ at: "page-2" });
		rpc.close();
	});
});
