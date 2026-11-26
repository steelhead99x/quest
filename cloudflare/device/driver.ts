// What a device driver gives the bench: who the device is, how hot and
// charged it is, and one page load measured the same way on every browser.

/** A device under test, as the report and baselines name it. */
export interface DeviceInfo {
	kind: "android" | "ipad";
	model: string;
	os: string;
	browser: string;
	/** Battery percentage, or null when the device does not say. */
	battery: number | null;
	/** True when the device reports thermal throttling, null when it cannot say. */
	throttled: boolean | null;
	/** A note on what this device could not set, such as text size, for the report. */
	limits: string[];
}

/** The page's own timings, from its Navigation Timing entry, in milliseconds. */
export interface PageTiming {
	/** Request start to the last byte of the HTML. */
	response: number;
	/** Navigation start to the first contentful paint, or null when none was reported. */
	paint: number | null;
	/** Navigation start to the load event's end. */
	load: number;
	/** Bytes over the network for the page and its subresources. */
	bytes: number;
	/** The Worker's own time, summed from Server-Timing durations, or null without the header. */
	worker: number | null;
	/** The HTTP status of the page. */
	status: number;
	/** Where the page ended up, after any redirect, such as to GitHub's sign-in. */
	url: string;
}

/** One measured load: the page's timings and the driver's own clock around it. */
export interface Load extends PageTiming {
	/** Milliseconds the driver waited from asking for the load to seeing it end. */
	wall: number;
}

/**
 * What opening a page offline gave: the page itself, from the service worker's cache;
 * only the site's offline notice, which the worker serves for a page it doesn't keep
 * (always, for signed-in pages); or nothing.
 */
export type OfflineView = "page" | "notice" | "none";

/** Whether the page can be installed to the home screen, and what opening it offline gives. */
export interface Installable {
	manifest: boolean;
	serviceWorker: boolean;
	offline: OfflineView;
	errors: string[];
}

/** Whether a loaded document is the site's offline notice, which marks its root element. */
export const OFFLINE_NOTICE_SCRIPT = `document.documentElement.hasAttribute("data-offline-notice")`;

/** A device the bench can drive. */
export interface Driver {
	info(): Promise<DeviceInfo>;
	/** Load `url`; `cold` clears the browser's cache and the site's storage first. */
	load(url: string, cold: boolean): Promise<Load>;
	installable(url: string): Promise<Installable>;
	/** A PNG of the page in the given colour scheme. */
	screenshot(url: string, dark: boolean): Promise<Uint8Array>;
	/** Undo anything the driver changed on the device, such as text size. */
	close(): Promise<void>;
}

/**
 * The script both drivers evaluate after load. It reads the page's own
 * Navigation Timing entry and paint entries, so Chrome and Safari report the
 * same fields, and returns them as JSON.
 */
export const TIMING_SCRIPT = `JSON.stringify((() => {
	const n = performance.getEntriesByType("navigation")[0];
	const paint = performance.getEntriesByName("first-contentful-paint")[0];
	const resources = performance.getEntriesByType("resource");
	const worker = (n.serverTiming || []).reduce((sum, t) => sum + (t.duration || 0), 0);
	return {
		response: n.responseEnd - n.requestStart,
		paint: paint ? paint.startTime : null,
		load: n.loadEventEnd,
		bytes: (n.transferSize || 0) + resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
		worker: (n.serverTiming || []).length ? worker : null,
		status: n.responseStatus || 0,
		url: location.href,
	};
})())`;

/**
 * A promise, as script text, that resolves true once a service worker controls
 * the page: it waits for registration to finish and for the worker to claim
 * the page, giving up after three seconds, since a page registers it after load.
 */
export const CONTROLLED_SCRIPT = `(navigator.serviceWorker ? Promise.race([
	navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller !== null || new Promise((resolve) =>
		navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true }))),
	new Promise((resolve) => setTimeout(() => resolve(navigator.serviceWorker.controller !== null), 3000)),
]) : Promise.resolve(false))`;

/** Read what TIMING_SCRIPT returned, refusing anything that is not its shape. */
export function pageTiming(json: unknown): PageTiming {
	if (typeof json !== "string") throw new Error("the page returned no timing");
	const v = JSON.parse(json) as Record<string, unknown>;
	const num = (key: string, nullable = false): number | null => {
		const x = v[key];
		if (nullable && x === null) return null;
		if (typeof x !== "number" || !Number.isFinite(x) || x < 0)
			throw new Error(`the page's ${key} timing is invalid`);
		return x;
	};
	return {
		response: num("response")!,
		paint: num("paint", true),
		load: num("load")!,
		bytes: num("bytes")!,
		worker: num("worker", true),
		status: num("status")!,
		url: typeof v.url === "string" ? v.url : "",
	};
}
