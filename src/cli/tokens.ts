// This host's Kixel Quest sign-ins, which `quest login` writes, and the Kixel Quest they pair with: one built-in URL,
// or the one `QUEST_KIXEL_URL` names. The forge reads and the record sender both send a token only to the URL the
// user's file pairs it with.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Kixel Quest's own URL. */
export const KIXEL_QUEST = "https://kixel.quest";
/** The variable naming another Kixel Quest, such as one running locally. */
export const KIXEL_QUEST_URL = "QUEST_KIXEL_URL";

/** One sign-in: the token this host posts with, and whether its person agreed to upload transcripts. */
export interface Login {
	token: string;
	transcripts: boolean;
}

const configDirectory = (env: NodeJS.ProcessEnv) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "quest");

/** The host's sign-ins, by the Kixel Quest URL each token may be sent to: `{"https://...": {"token", "transcripts"}}`. */
export function tokensPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configDirectory(env), "login.json");
}

/**
 * The Kixel Quest `env` names, as its origin, the form git's credential requests take; a malformed or clear-text URL,
 * or one with a path, throws.
 */
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
	// Kixel Quest's routes, its git repositories included, sit at the root of its origin.
	if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
		throw new Error(`${KIXEL_QUEST_URL}: ${named} is not an origin, such as ${KIXEL_QUEST}`);
	return url.origin;
}

/** What follows the origin in `value`, without its leading slash, when `value` is a URL on the Kixel Quest at `base`. */
export function kixelPath(value: string, base: string): string | null {
	const url = URL.parse(value);
	if (url === null || url.origin !== base) return null;
	return `${url.pathname.slice(1)}${url.search}${url.hash}`;
}

/** The token this host signed in to `url` with, or null. */
export function tokenFor(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
	return readLogins(env)[url]?.token ?? null;
}

/** The token this host signed in to `url` with, failing with what to run when it has none. */
export function requireToken(url: string, env: NodeJS.ProcessEnv = process.env): string {
	const token = tokenFor(url, env);
	if (token === null) throw new Error(notSignedIn(url));
	return token;
}

/** What a host holding no token for `url` is told. */
export const notSignedIn = (url: string) => `this host is not signed in to ${url}; run \`quest login\``;

/** Pair `login` with `url`, replacing any earlier sign-in there. */
export function saveLogin(url: string, login: Login, env: NodeJS.ProcessEnv = process.env): void {
	write(tokensPath(env), { ...readLogins(env), [url]: login });
}

/** Forget the sign-in to `url`, returning whether there was one. */
export function removeLogin(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const logins = readLogins(env);
	if (!(url in logins)) return false;
	delete logins[url];
	write(tokensPath(env), logins);
	return true;
}

function readLogins(env: NodeJS.ProcessEnv): Record<string, Login> {
	const path = tokensPath(env);
	if (!existsSync(path)) return moveTokens(env);
	const logins = readObject(path);
	for (const [url, login] of Object.entries(logins)) {
		const { token, transcripts } = (login ?? {}) as Partial<Login>;
		if (
			typeof login !== "object" ||
			login === null ||
			typeof token !== "string" ||
			token === "" ||
			typeof transcripts !== "boolean"
		)
			throw new Error(`${path}: the sign-in to ${url} is not {"token": "...", "transcripts": true or false}`);
	}
	return logins as Record<string, Login>;
}

/**
 * Move the tokens an earlier quest read from `records.json`, `{"https://...": "token"}`, into the sign-ins file, as
 * sign-ins whose person was never asked about transcripts, so they upload none.
 */
function moveTokens(env: NodeJS.ProcessEnv): Record<string, Login> {
	const old = join(configDirectory(env), "records.json");
	const path = tokensPath(env);
	let text: string;
	try {
		text = readFileSync(old, "utf8");
	} catch (error) {
		// None, or another quest moved it first, which writes the sign-ins before removing it.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return existsSync(path) ? readLogins(env) : {};
		throw error;
	}
	const logins: Record<string, Login> = {};
	for (const [url, token] of Object.entries(parseObject(old, text))) {
		if (typeof token !== "string" || token === "") throw new Error(`${old}: the token for ${url} is not a string`);
		logins[url] = { token, transcripts: false };
	}
	// Linked rather than renamed, so a move racing another quest's never overwrites a sign-in written since.
	const next = stage(path, logins);
	try {
		linkSync(next, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		rmSync(old, { force: true });
		return readLogins(env);
	} finally {
		rmSync(next, { force: true });
	}
	rmSync(old, { force: true });
	return logins;
}

const readObject = (path: string) => parseObject(path, readFileSync(path, "utf8"));

function parseObject(path: string, text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${path} does not hold an object by Kixel Quest URL`);
	return parsed as Record<string, unknown>;
}

/** Write `logins` whole, readable only by the user, then rename, so no reader sees half a file. */
function write(path: string, logins: Record<string, Login>): void {
	renameSync(stage(path, logins), path);
}

/** `logins` written beside `path`, readable only by the user, returning where. */
function stage(path: string, logins: Record<string, Login>): string {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const next = `${path}.${process.pid}.new`;
	writeFileSync(next, `${JSON.stringify(logins, null, "\t")}\n`, { mode: 0o600 });
	return next;
}
