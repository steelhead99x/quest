// A short-lived cache in front of GitHub, through the Workers Cache API. Every
// key includes the signed-in person's GitHub id, so one person's data is never
// served to another, and a caller rechecks access before using a hit for a
// private repository, so revoked access ends at once rather than after the
// TTL. On workers.dev the Cache API stores nothing, so every page reads GitHub
// afresh there.

/** Seconds a board's data stays fresh: long enough to move between its pages without refetching. */
export const TTL = 30;

/** The cached value for `key` in `cache`, or what `load` returns, stored for `ttl` seconds. */
export async function cached<T>(
	cache: Cache | null,
	key: string,
	load: () => Promise<T>,
	ttl = TTL,
): Promise<{ value: T; hit: boolean }> {
	const url = `https://cache.quest.internal/${encodeURIComponent(key)}`;
	if (cache) {
		const found = await cache.match(url);
		if (found) return { value: (await found.json()) as T, hit: true };
	}
	const value = await load();
	if (cache)
		await cache.put(
			url,
			new Response(JSON.stringify(value), {
				headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
			}),
		);
	return { value, hit: false };
}

/** Delete `key`, so the next page reads GitHub afresh. */
export async function forget(cache: Cache | null, key: string): Promise<void> {
	await cache?.delete(`https://cache.quest.internal/${encodeURIComponent(key)}`);
}
