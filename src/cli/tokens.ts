// The user's Kixel Quest tokens, and the Kixel Quest they pair with: one built-in URL, or the one `QUEST_KIXEL_URL`
// names. The forge reads and the record sender both send a token only to the URL their user's file pairs it with.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Kixel Quest's own URL. */
export const KIXEL_QUEST = "https://kixel.quest";
/** The variable naming another Kixel Quest, such as one running locally. */
export const KIXEL_QUEST_URL = "QUEST_KIXEL_URL";

/** The user's tokens, by the Kixel Quest URL each may be sent to: `{"https://...": "token"}`. */
export function tokensPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "quest", "records.json");
}

/** The Kixel Quest `env` names, without a trailing slash; a malformed or clear-text URL throws. */
export function kixelUrl(env: NodeJS.ProcessEnv): string {
	const named = env[KIXEL_QUEST_URL] || KIXEL_QUEST;
	let url: URL;
	try {
		url = new URL(named);
	} catch {
		throw new Error(`${KIXEL_QUEST_URL}: ${named} is not a URL`);
	}
	// Anything but HTTPS, or HTTP to this host for a local store, would send the token in clear.
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new Error(`${KIXEL_QUEST_URL}: ${named} is not an HTTPS URL`);
	return named.replace(/\/+$/, "");
}

/** The token the user paired with `url`, or null. */
export function tokenFor(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const path = tokensPath(env);
	if (!existsSync(path)) return null;
	let tokens: unknown;
	try {
		tokens = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not JSON: ${(error as Error).message}`);
	}
	if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens))
		throw new Error(`${path} does not hold an object of tokens by URL`);
	const token = (tokens as Record<string, unknown>)[url];
	if (token === undefined) return null;
	if (typeof token !== "string" || token === "") throw new Error(`${path}: the token for ${url} is not a string`);
	return token;
}
