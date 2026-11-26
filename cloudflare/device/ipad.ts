// Drive Safari on an iPad from Linux or macOS: libimobiledevice for the
// device's identity and battery, and ios-webkit-debug-proxy for Safari's
// WebKit inspector. Current iOS routes inspector calls through a page target.

import type { Subprocess } from "bun";
import {
	type DeviceInfo,
	type Driver,
	type Installable,
	type Load,
	CONTROLLED_SCRIPT,
	pageTiming,
	TIMING_SCRIPT,
} from "./driver.ts";
import { type Message, Rpc } from "./rpc.ts";
import { type Shell, sleep } from "./shell.ts";

/** The one attached iPad's UDID, or the one named. */
export function udid(list: string, wanted?: string): string {
	const ids = list
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (wanted) {
		if (!ids.includes(wanted)) throw new Error(`no iOS device ${wanted} is attached`);
		return wanted;
	}
	if (ids.length === 0) throw new Error("no iPad is attached over USB, or it has not trusted this computer");
	if (ids.length > 1) throw new Error("several iOS devices are attached; pick one with --ipad-udid");
	return ids[0]!;
}

/** The Safari tab ios-webkit-debug-proxy lists, which must exist for the inspector to reach. */
export function tab(pages: unknown): string {
	if (!Array.isArray(pages)) throw new Error("ios-webkit-debug-proxy listed no pages");
	const page = pages.find((p) => typeof p?.webSocketDebuggerUrl === "string") as
		{ webSocketDebuggerUrl: string } | undefined;
	if (!page)
		throw new Error(
			"Safari has no inspectable tab: open Safari on the iPad with one tab, and turn on Settings, Apps, Safari, Advanced, Web Inspector",
		);
	return page.webSocketDebuggerUrl;
}

/** Calls to a WebKit page target, wrapped in Target messages as iOS requires. */
export class Target {
	private next = 1;
	private readonly pending = new Map<number, (m: Message) => void>();
	private readonly events = new Set<(m: Message) => void>();

	constructor(
		private readonly rpc: Rpc,
		private readonly id: string,
		private readonly timeout: number,
	) {
		rpc.listen((m) => {
			if (m.method !== "Target.dispatchMessageFromTarget" || m.params?.targetId !== id) return;
			let inner: Message;
			try {
				inner = JSON.parse(String(m.params?.message)) as Message;
			} catch {
				return;
			}
			if (typeof inner.id === "number") {
				this.pending.get(inner.id)?.(inner);
				this.pending.delete(inner.id);
			} else for (const listener of [...this.events]) listener(inner);
		});
	}

	async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = this.next++;
		const reply = new Promise<Message>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} got no answer from Safari within ${this.timeout} ms`));
			}, this.timeout);
			this.pending.set(id, (m) => (clearTimeout(timer), resolve(m)));
		});
		await this.rpc.call("Target.sendMessageToTarget", {
			targetId: this.id,
			message: JSON.stringify({ id, method, params }),
		});
		const m = await reply;
		if (m.error) throw new Error(`${method} failed: ${m.error.message ?? JSON.stringify(m.error)}`);
		return m.result ?? {};
	}

	event(method: string): Promise<Message> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.events.delete(listener);
				reject(new Error(`no ${method} from Safari within ${this.timeout} ms`));
			}, this.timeout);
			const listener = (m: Message) => {
				if (m.method !== method) return;
				clearTimeout(timer);
				this.events.delete(listener);
				resolve(m);
			};
			this.events.add(listener);
		});
	}
}

/** Safari on the attached iPad. */
export class Ipad implements Driver {
	private constructor(
		private readonly sh: Shell,
		private readonly id: string,
		private readonly proxy: Subprocess,
		private readonly rpc: Rpc,
		private readonly page: Target,
		private readonly timeout: number,
	) {}

	/** Find the iPad, start ios-webkit-debug-proxy on `port`, and attach to Safari's tab. */
	static async open(sh: Shell, port: number, timeout: number, wanted?: string): Promise<Ipad> {
		const id = udid(await sh("idevice_id", ["-l"]), wanted);
		if (!Bun.which("ios_webkit_debug_proxy"))
			throw new Error("ios_webkit_debug_proxy is not installed or not on PATH");
		const proxy = Bun.spawn(["ios_webkit_debug_proxy", "--no-frontend", "-c", `${id}:${port}`], {
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			const url = tab(await pages(port, timeout));
			const rpc = await Rpc.connect(url, timeout);
			const created = await rpc.event("Target.targetCreated", (p) => {
				const info = p.targetInfo as { type?: string } | undefined;
				return info?.type === "page";
			});
			const targetId = (created.params?.targetInfo as { targetId?: string } | undefined)?.targetId;
			if (!targetId) throw new Error("Safari announced a page target without an id");
			const page = new Target(rpc, targetId, timeout);
			await page.call("Page.enable");
			await page.call("Network.enable");
			return new Ipad(sh, id, proxy, rpc, page, timeout);
		} catch (error) {
			proxy.kill();
			throw error;
		}
	}

	async info(): Promise<DeviceInfo> {
		const key = async (k: string, domain?: string) =>
			(await this.sh("ideviceinfo", ["-u", this.id, ...(domain ? ["-q", domain] : []), "-k", k])).trim();
		const capacity = Number(await key("BatteryCurrentCapacity", "com.apple.mobile.battery"));
		const agent = await this.evaluate("navigator.userAgent");
		const safari = /Version\/([\d.]+)/.exec(String(agent))?.[1];
		return {
			kind: "ipad",
			model: await key("ProductType"),
			os: `iPadOS ${await key("ProductVersion")}`,
			browser: safari ? `Safari ${safari}` : "Safari",
			battery: Number.isFinite(capacity) ? capacity : null,
			// iPadOS shares no thermal state over USB.
			throttled: null,
			limits: [
				"text size: set Larger Text on the iPad by hand before screenshots; the inspector cannot",
				"offline: checked as the page being in the service worker's cache; the inspector cannot cut Safari's network",
				"thermal state: not shared by iPadOS over USB",
			],
		};
	}

	async load(url: string, cold: boolean): Promise<Load> {
		if (cold) {
			// Safari's inspector has no storage wipe: unregister the site's service worker and
			// caches from the page itself, then load without the HTTP cache.
			await this.evaluate(
				`(async () => { for (const r of await navigator.serviceWorker?.getRegistrations?.() ?? []) await r.unregister();` +
					` for (const k of await caches?.keys?.() ?? []) await caches.delete(k); return true })()`,
			).catch(() => undefined);
			await this.page.call("Network.setResourceCachingDisabled", { disabled: true });
		}
		try {
			return await this.navigate(url);
		} finally {
			if (cold) await this.page.call("Network.setResourceCachingDisabled", { disabled: false });
		}
	}

	async installable(url: string): Promise<Installable> {
		await this.navigate(url);
		const result = await this.evaluateAsync(`(async () => {
			const link = document.querySelector('link[rel="manifest"]');
			const errors = [];
			let manifest = false;
			if (!link) errors.push("no manifest link");
			else {
				const m = await (await fetch(link.href)).json();
				if (!m.name && !m.short_name) errors.push("manifest has no name");
				if (!(m.icons || []).length) errors.push("manifest has no icons");
				if (!["standalone", "fullscreen", "minimal-ui"].includes(m.display)) errors.push("manifest display is not standalone");
				manifest = errors.length === 0;
			}
			const sw = await ${CONTROLLED_SCRIPT};
			const cached = Boolean(await caches.match(location.href));
			return JSON.stringify({ manifest, serviceWorker: sw, offline: cached, errors });
		})()`);
		const v = JSON.parse(String(result)) as Installable;
		return {
			manifest: v.manifest === true,
			serviceWorker: v.serviceWorker === true,
			offline: v.offline === true,
			errors: Array.isArray(v.errors) ? v.errors.map(String) : [],
		};
	}

	async screenshot(url: string, dark: boolean): Promise<Uint8Array> {
		await this.page.call("Page.setForcedAppearance", { appearance: dark ? "Dark" : "Light" });
		try {
			await this.navigate(url);
			const size = JSON.parse(
				String(await this.evaluate("JSON.stringify([innerWidth, innerHeight])")),
			) as number[];
			const shot = (await this.page.call("Page.snapshotRect", {
				x: 0,
				y: 0,
				width: size[0],
				height: size[1],
				coordinateSystem: "Viewport",
			})) as { dataURL?: string };
			const data = shot.dataURL?.replace(/^data:image\/png;base64,/, "");
			if (!data) throw new Error("Safari returned no screenshot");
			return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		} finally {
			await this.page.call("Page.setForcedAppearance", { appearance: "" });
		}
	}

	async close(): Promise<void> {
		this.rpc.close();
		this.proxy.kill();
		await this.proxy.exited;
	}

	private async navigate(url: string): Promise<Load> {
		const loaded = this.page.event("Page.loadEventFired");
		const start = performance.now();
		await this.page.call("Page.navigate", { url });
		await loaded;
		const wall = performance.now() - start;
		for (let i = 0; i < 50; i++) {
			if ((await this.evaluate(`performance.getEntriesByType("navigation")[0]?.loadEventEnd > 0`)) === true)
				return { ...pageTiming(await this.evaluate(TIMING_SCRIPT)), wall };
			await sleep(20);
		}
		throw new Error("the page's load event never finished");
	}

	private async evaluate(expression: string): Promise<unknown> {
		const out = (await this.page.call("Runtime.evaluate", { expression, returnByValue: true })) as {
			result?: { value?: unknown };
			wasThrown?: boolean;
		};
		if (out.wasThrown) throw new Error(`the page threw evaluating ${expression.slice(0, 60)}`);
		return out.result?.value;
	}

	/** Evaluate a promise-returning expression, polling a page global since WebKit cannot await one. */
	private async evaluateAsync(expression: string): Promise<unknown> {
		const key = `__questBench${Date.now()}`;
		await this.evaluate(`(${expression}).then(v => window.${key} = {v}, e => window.${key} = {e: String(e)}); 0`);
		for (let i = 0; i * 50 < this.timeout; i++) {
			const raw = await this.evaluate(`JSON.stringify(window.${key} ?? null)`);
			const done = JSON.parse(String(raw)) as { v?: unknown; e?: string } | null;
			if (done) {
				if (done.e) throw new Error(`the page failed: ${done.e}`);
				return done.v;
			}
			await sleep(50);
		}
		throw new Error("the page's check never finished");
	}
}

/** The pages ios-webkit-debug-proxy lists once it has reached the device. */
async function pages(port: number, timeout: number): Promise<unknown> {
	const deadline = Date.now() + timeout;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) {
				last = await response.json();
				if (Array.isArray(last) && last.length > 0) return last;
			}
		} catch {
			// The proxy is still starting.
		}
		await sleep(250);
	}
	return last;
}
