// A short-lived cache in front of GitHub, through the Workers Cache API. Every
// key includes the signed-in person's GitHub id, so one person's private data
// is never served to another. On workers.dev the Cache API stores nothing, so
// every page reads GitHub afresh there.

/** Seconds a board's data stays fresh: long enough to move between its pages without refetching. */
export const TTL = 30;

/** The cached value for `key` in `cache`, or what `load` returns, stored for `ttl` seconds. */
export async function cached<T>(cache: Cache | null, key: string, load: () => Promise<T>, ttl = TTL): Promise<T> {
	const url = `https://cache.quest.internal/${encodeURIComponent(key)}`;
	if (cache) {
		const hit = await cache.match(url);
		if (hit) return (await hit.json()) as T;
	}
	const value = await load();
	if (cache)
		await cache.put(
			url,
			new Response(JSON.stringify(value), {
				headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
			}),
		);
	return value;
}
