// The service worker: the shell from the cache, and pages from the network.
// Only pages the Worker marks public are kept for offline reading; a page
// rendered for a signed-in person is sent `no-store` and never kept, so a
// private page cannot outlive the session that fetched it. Offline, a page
// with no public copy shows /offline.
const VERSION = "__VERSION__";
const SHELL = `shell-${VERSION}`;
// Renamed whenever what it may hold changes, so an upgrade drops the old copies.
const PAGES = "pages-public-1";
const OFFLINE = "/offline";
// The most pages kept for offline reading, oldest dropped first.
const MAX_PAGES = 30;
const ASSETS = [
	"/site.css",
	"/app.js",
	"/theme/theme.css",
	"/brand/logo.svg",
	"/brand/route.svg",
	"/brand/icon-192.png",
	"/brand/icon-512.png",
	"/brand/icon-180.png",
	"/manifest.webmanifest",
	"/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2",
	"/fonts/atkinson-hyperlegible-next-latin-wght-italic.woff2",
	"/fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2",
	OFFLINE,
];
// Not /og.png: only link previews fetch it, never a page, and at about 50 KB it was
// nearly half of what install downloaded before the worker could take control.

self.addEventListener("install", (event) =>
	event.waitUntil(
		caches
			.open(SHELL)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting()),
	),
);

// Every cache but this version's shell and the public pages goes, including
// the private pages an earlier version kept.
self.addEventListener("activate", (event) =>
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== SHELL && key !== PAGES) await caches.delete(key);
			await self.clients.claim();
		})(),
	),
);

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
		return;
	}
	// Sign-in steps are never replayed from a cache.
	if (event.request.mode !== "navigate" || url.pathname.startsWith("/sign-") || url.pathname.startsWith("/auth/"))
		return;
	event.respondWith(page(event));
});

/** Whether a response may be kept: the Worker sends `private, no-store` for anything rendered with a session. */
function shareable(response) {
	const control = response.headers.get("cache-control") || "";
	return response.ok && !/no-store|private/.test(control);
}

// Network first, so pages are always fresh online; a public copy is kept after
// the page is handed over, so caching never delays it.
async function page(event) {
	try {
		const response = await fetch(event.request);
		if (shareable(response)) event.waitUntil(keep(event.request, response.clone()));
		return response;
	} catch (error) {
		const hit = (await caches.match(event.request, { cacheName: PAGES })) || (await caches.match(OFFLINE));
		if (hit) return hit;
		throw error;
	}
}

async function keep(request, response) {
	const cache = await caches.open(PAGES);
	// keys() lists entries in insertion order, and a put over an existing entry may keep its
	// place. Deleting first makes a refreshed page the newest, so the trim drops the oldest.
	await cache.delete(request);
	await cache.put(request, response);
	const keys = await cache.keys();
	for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(old);
}
