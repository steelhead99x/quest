// GitHub GET answers kept on disk, so quest's one-process-per-command runs revalidate by ETag across runs.
import { homedir } from "node:os";
import { join } from "node:path";

import type { CachedResponse, ResponseCache } from "../github/client";
import { diskCache } from "./disk-cache";

/** The cache's size bound; past it, the least recently used entries go first. */
const LIMIT = 64 * 1024 * 1024;

/** Where the cache lives: `$XDG_CACHE_HOME/quest/github`, else `~/.cache/quest/github`. */
export function responseCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "quest", "github");
}

/** A {@link ResponseCache} on disk, private to its user and bounded by `limit` bytes (see {@link diskCache}). */
export function diskResponseCache(directory: string, limit = LIMIT): ResponseCache {
	return diskCache(directory, parse, limit);
}

function parse(value: unknown): CachedResponse | undefined {
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
