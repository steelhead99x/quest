// GitHub GET answers kept on disk, so quest's one-process-per-command runs revalidate by ETag across runs.
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CachedResponse, ResponseCache } from "../github/client";

/** The cache's size bound; past it, the least recently used entries go first. */
const LIMIT = 64 * 1024 * 1024;

/** Where the cache lives: `$XDG_CACHE_HOME/quest/github`, else `~/.cache/quest/github`. */
export function responseCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "quest", "github");
}

/**
 * A {@link ResponseCache} of one file per entry in `directory`, private to its user. Writes rename
 * a finished file into place, so concurrent processes never read a partial entry. Each process sums
 * the directory on its first write, whenever its writes since would pass `limit`, and after every
 * eighth of `limit` it writes, so other processes' writes are counted too, evicting the least recently
 * used down to three quarters of `limit` once past it. Concurrent writers can each pass `limit` by up
 * to an eighth of it until the next sum; summing on every write would hold it exactly, at about
 * 100 ms a write for a full directory. An entry over an eighth of `limit` is not kept.
 */
export function diskResponseCache(directory: string, limit = LIMIT): ResponseCache {
	/** The directory's size at this process's last sum, undefined before the first, and bytes written since. */
	let summed: number | undefined;
	let written = 0;
	const path = (key: string) => {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid response cache key: ${key}`);
		return join(directory, key);
	};
	const evict = async () => {
		const entries: { file: string; size: number; used: number }[] = [];
		for (const name of await readdir(directory)) {
			const file = join(directory, name);
			const info = await stat(file).catch(missing);
			if (info) entries.push({ file, size: info.size, used: info.mtimeMs });
		}
		let total = entries.reduce((sum, entry) => sum + entry.size, 0);
		if (total > limit) {
			entries.sort((a, b) => a.used - b.used);
			for (const entry of entries) {
				if (total <= (limit * 3) / 4) break;
				await unlink(entry.file).catch(missing);
				total -= entry.size;
			}
		}
		summed = total;
		written = 0;
	};
	return {
		async get(key) {
			const file = path(key);
			const text = await readFile(file, "utf8").catch(missing);
			if (text === undefined) return undefined;
			const entry = parse(text);
			// Another version's or a damaged entry is only a miss: the next answer replaces it.
			if (!entry) {
				await unlink(file).catch(missing);
				return undefined;
			}
			const now = new Date();
			await utimes(file, now, now).catch(missing);
			return entry;
		},
		async set(key, entry) {
			const file = path(key);
			const text = JSON.stringify(entry);
			const size = Buffer.byteLength(text);
			if (size > limit / 8) return;
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, text, { mode: 0o600 });
			// Another process's eviction may take the file first; the entry is then just not kept.
			await rename(temporary, file).catch(missing);
			written += size;
			if (summed === undefined || summed + written > limit || written > limit / 8) await evict();
		},
	};
}

function parse(text: string): CachedResponse | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { etag, headers, body } = value as Record<string, unknown>;
	if (typeof etag !== "string" || !etag || typeof body !== "string" || !Array.isArray(headers)) return undefined;
	if (
		!headers.every(
			(pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"),
		)
	)
		return undefined;
	return { etag, headers: headers as [string, string][], body };
}

/** `undefined` for a file another process removed, rethrowing anything else. */
function missing(error: unknown): undefined {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
	throw error;
}
