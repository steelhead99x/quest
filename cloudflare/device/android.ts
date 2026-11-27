// Drive Chrome on an Android phone over adb with the Chrome DevTools Protocol.

import {
	type DeviceInfo,
	type Driver,
	type Installable,
	type Load,
	type OfflineView,
	CONTROLLED_SCRIPT,
	OFFLINE_NOTICE_SCRIPT,
	pageTiming,
	TIMING_SCRIPT,
} from "./driver.ts";
import { Offline } from "./offline.ts";
import { Rpc } from "./rpc.ts";
import { type Shell, sleep } from "./shell.ts";

const CHROME = "com.android.chrome/com.google.android.apps.chrome.Main";
/** Android's largest font scale in its accessibility settings. */
const LARGEST_FONT = "2.0";
/** Thermal status at or above Android's "moderate", when the OS starts throttling. */
const THROTTLING = 2;

/** The one attached, authorized device's serial, or the one named. */
export function serial(devices: string, wanted?: string): string {
	const rows = devices
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.filter((cols) => cols.length >= 2 && cols[0]);
	const pick = wanted ? rows.filter((r) => r[0] === wanted) : rows;
	if (pick.length === 0)
		throw new Error(wanted ? `adb lists no device ${wanted}` : "no Android device is attached over adb");
	if (pick.length > 1) throw new Error(`several Android devices are attached; pick one with --android-serial`);
	const [id, state] = pick[0]!;
	if (state === "unauthorized")
		throw new Error(`${id} has not authorized this computer: accept the USB debugging prompt`);
	if (state !== "device") throw new Error(`${id} is ${state}, not ready for adb`);
	return id!;
}

/** Battery level and Android's thermal status from `dumpsys`. */
export function health(battery: string, thermal: string): { battery: number | null; throttled: boolean | null } {
	const level = /^\s*level:\s*(\d+)/m.exec(battery);
	const status = /Thermal Status:\s*(\d+)/.exec(thermal);
	return {
		battery: level ? Number(level[1]) : null,
		throttled: status ? Number(status[1]) >= THROTTLING : null,
	};
}

/** Chrome on the attached phone, through a forwarded DevTools port. */
export class Android implements Driver {
	private page: Rpc | null = null;

	private constructor(
		private readonly sh: Shell,
		private readonly id: string,
		private readonly port: number,
		private readonly timeout: number,
	) {}

	/** Find the phone, start Chrome, and forward its DevTools socket to `port`. */
	static async open(sh: Shell, port: number, timeout: number, wanted?: string): Promise<Android> {
		const id = serial(await sh("adb", ["devices"]), wanted);
		const android = new Android(sh, id, port, timeout);
		await android.adb(["shell", "am", "start", "-n", CHROME, "-d", "about:blank"]);
		await android.adb(["forward", `tcp:${port}`, "localabstract:chrome_devtools_remote"]);
		return android;
	}

	async info(): Promise<DeviceInfo> {
		const prop = async (name: string) => (await this.adb(["shell", "getprop", name])).trim();
		const version = (await this.json("/json/version")) as { Browser?: string };
		const h = health(
			await this.adb(["shell", "dumpsys", "battery"]),
			await this.adb(["shell", "dumpsys", "thermalservice"]),
		);
		return {
			kind: "android",
			model: await prop("ro.product.model"),
			os: `Android ${await prop("ro.build.version.release")}`,
			browser: version.Browser ?? "Chrome",
			...h,
			limits: [],
		};
	}

	async load(url: string, cold: boolean): Promise<Load> {
		const page = await this.connect();
		if (cold) {
			await page.call("Network.clearBrowserCache");
			// Not cookies: a signed-in page stays signed in.
			await page.call("Storage.clearDataForOrigin", {
				origin: new URL(url).origin,
				storageTypes: "cache_storage,service_workers,local_storage,indexeddb",
			});
		}
		return this.navigate(page, url);
	}

	async installable(url: string): Promise<Installable> {
		const page = await this.connect();
		await this.navigate(page, url);
		const manifest = (await page.call("Page.getAppManifest")) as { url?: string; errors?: { message: string }[] };
		const installability = (await page.call("Page.getInstallabilityErrors")) as {
			installabilityErrors?: { errorId: string }[];
		};
		const controlled = await this.evaluate(page, CONTROLLED_SCRIPT, true);
		// Both the page and its service worker go offline: the page's switch alone leaves the worker online.
		const workers = await Offline.attach(this.port, this.timeout);
		const conditions = (offline: boolean) => ({
			offline,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
		});
		let offline: OfflineView = "none";
		try {
			await page.call("Network.emulateNetworkConditions", conditions(true));
			await workers.set(true);
			// The offline notice also answers 200, so a 200 alone doesn't say the page itself opened.
			if (workers.workers > 0 && (await this.navigate(page, url)).status === 200)
				offline = (await this.evaluate(page, OFFLINE_NOTICE_SCRIPT, false)) === true ? "notice" : "page";
		} catch {
			offline = "none";
		} finally {
			await workers.set(false);
			workers.close();
			await page.call("Network.emulateNetworkConditions", conditions(false));
		}
		return {
			manifest: Boolean(manifest.url) && (manifest.errors ?? []).length === 0,
			serviceWorker: controlled === true,
			offline,
			errors: [
				...(manifest.errors ?? []).map((e) => e.message),
				...(installability.installabilityErrors ?? []).map((e) => e.errorId),
			],
		};
	}

	async screenshot(url: string, dark: boolean): Promise<Uint8Array> {
		const page = await this.connect();
		const before = (await this.adb(["shell", "settings", "get", "system", "font_scale"])).trim();
		await this.adb(["shell", "settings", "put", "system", "font_scale", LARGEST_FONT]);
		try {
			await page.call("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
			});
			await this.navigate(page, url);
			const shot = (await page.call("Page.captureScreenshot", { format: "png" })) as { data?: string };
			if (!shot.data) throw new Error("Chrome returned no screenshot");
			return Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
		} finally {
			await page.call("Emulation.setEmulatedMedia", { features: [] });
			// "null" means the user never set one; put back Android's default.
			await this.adb(["shell", "settings", "put", "system", "font_scale", before === "null" ? "1.0" : before]);
		}
	}

	async close(): Promise<void> {
		this.page?.close();
		await this.adb(["forward", "--remove", `tcp:${this.port}`]);
	}

	private adb(args: string[]): Promise<string> {
		return this.sh("adb", ["-s", this.id, ...args]);
	}

	private async json(path: string, method = "GET"): Promise<unknown> {
		const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
			method,
			signal: AbortSignal.timeout(this.timeout),
		});
		if (!response.ok) throw new Error(`Chrome's DevTools ${path} answered ${response.status}`);
		return response.json();
	}

	private async connect(): Promise<Rpc> {
		if (this.page) return this.page;
		const target = (await this.json("/json/new?about:blank", "PUT")) as { webSocketDebuggerUrl?: string };
		if (!target.webSocketDebuggerUrl) throw new Error("Chrome opened a tab without a DevTools socket");
		const page = await Rpc.connect(target.webSocketDebuggerUrl, this.timeout);
		await page.call("Page.enable");
		await page.call("Network.enable");
		this.page = page;
		return page;
	}

	private async navigate(page: Rpc, url: string): Promise<Load> {
		const loaded = page.event("Page.loadEventFired");
		const start = performance.now();
		const nav = (await page.call("Page.navigate", { url })) as { errorText?: string };
		if (nav.errorText) throw new Error(`Chrome could not load ${url}: ${nav.errorText}`);
		await loaded;
		const wall = performance.now() - start;
		return { ...(await this.timing(page)), wall };
	}

	private async timing(page: Rpc) {
		// loadEventEnd is set just after the load event fires.
		for (let i = 0; i < 50; i++) {
			const value = await this.evaluate(page, `performance.getEntriesByType("navigation")[0]?.loadEventEnd > 0`);
			if (value === true) return pageTiming(await this.evaluate(page, TIMING_SCRIPT));
			await sleep(20);
		}
		throw new Error("the page's load event never finished");
	}

	private async evaluate(page: Rpc, expression: string, awaitPromise = false): Promise<unknown> {
		const out = (await page.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as {
			result?: { value?: unknown };
			exceptionDetails?: { text?: string };
		};
		if (out.exceptionDetails) throw new Error(`the page threw: ${out.exceptionDetails.text ?? "an exception"}`);
		return out.result?.value;
	}
}
