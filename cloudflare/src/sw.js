// The service worker: the shell from the cache, and pages from the network,
// falling back to the last copy of each when offline. Signing out sends
// Clear-Site-Data, which drops every cached page.
const VERSION = "__VERSION__";
const SHELL = `shell-${VERSION}`;
const PAGES = "pages";
// The most pages kept for offline reading, oldest dropped first.
const MAX_PAGES = 30;
const ASSETS = [
	"/site.css",
	"/app.js",
	"/theme/theme.css",
	"/theme/logo.svg",
	"/theme/icon-192.png",
	"/theme/icon-512.png",
	"/manifest.webmanifest",
];

self.addEventListener("install", (event) =>
	event.waitUntil(
		caches
			.open(SHELL)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting()),
	),
);

self.addEventListener("activate", (event) =>
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys())
				if (key.startsWith("shell-") && key !== SHELL) await caches.delete(key);
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

// Network first, so pages are always fresh online; the copy is kept after the
// page is handed over, so caching never delays it.
async function page(event) {
	try {
		const response = await fetch(event.request);
		if (response.ok) event.waitUntil(keep(event.request, response.clone()));
		return response;
	} catch (error) {
		const hit = await caches.match(event.request, { cacheName: PAGES });
		if (hit) return hit;
		throw error;
	}
}

async function keep(request, response) {
	const cache = await caches.open(PAGES);
	await cache.put(request, response);
	const keys = await cache.keys();
	for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(old);
}
