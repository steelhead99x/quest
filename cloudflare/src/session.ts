// A signed-in person's session, sealed into an HttpOnly cookie with AES-GCM
// under a key derived from AUTH_SECRET. There is no session store: the cookie
// is the session, and signing out drops it and revokes its GitHub token.

/** The session cookie; `__Host-` pins it to this origin over HTTPS with path `/`. */
export const SESSION = "__Host-quest-session";
/** The cookie that carries the OAuth state through GitHub's round trip. */
export const STATE = "__Host-quest-state";
/** Cookies a browser keeps for each name are capped near 4 KB; refuse anything near it. */
const MAX_COOKIE = 3800;

/** What the session cookie holds. */
export interface Session {
	/** GitHub's numeric user id. */
	id: number;
	login: string;
	/** The GitHub App user token, and when it expires (ms since the epoch). */
	token: string;
	expires: number;
	/** The refresh token, and when it expires. */
	refresh: string;
	refreshExpires: number;
}

/** What the state cookie holds while the person is on GitHub. */
export interface Pending {
	state: string;
	/** The path to return to, always on this site. */
	next: string;
	expires: number;
}

/** The AES-GCM key for `purpose`, derived from the deploy's secret. */
async function key(secret: string, purpose: string): Promise<CryptoKey> {
	if (secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode(`quest ${purpose}`) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Seal `value` for a cookie of `purpose`. */
export async function seal(secret: string, purpose: string, value: unknown): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(value));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret, purpose), data),
	);
	const out = base64url(iv) + "." + base64url(sealed);
	if (out.length > MAX_COOKIE) throw new Error(`a ${purpose} cookie would exceed ${MAX_COOKIE} bytes`);
	return out;
}

/** Open a cookie sealed for `purpose`, or null when it is missing, forged, or from another secret. */
export async function open(secret: string, purpose: string, cookie: string | undefined): Promise<unknown> {
	if (!cookie || cookie.length > MAX_COOKIE) return null;
	const [iv, data] = cookie.split(".");
	if (!iv || !data) return null;
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: unbase64url(iv) },
			await key(secret, purpose),
			unbase64url(data),
		);
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		// A tampered cookie or a rotated secret fails authentication: treat it as signed out.
		return null;
	}
}

/** Read a session, refusing one whose shape is wrong. */
export function session(value: unknown): Session | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	const ok =
		Number.isSafeInteger(v.id) &&
		typeof v.login === "string" &&
		typeof v.token === "string" &&
		typeof v.refresh === "string" &&
		Number.isFinite(v.expires) &&
		Number.isFinite(v.refreshExpires);
	return ok ? (v as unknown as Session) : null;
}

/** Read a pending sign-in, refusing an expired or malformed one. */
export function pending(value: unknown, now: number): Pending | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.state !== "string" || typeof v.next !== "string" || typeof v.expires !== "number") return null;
	return v.expires > now ? (v as unknown as Pending) : null;
}

/** A path on this site to return to, or `/` for anything else, such as `//evil.example` or a full URL. */
export function local(next: string | null | undefined): string {
	if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
	// URL parsers remove tabs and newlines before interpreting the path.
	return next.length > 512 || /[\u0000-\u001f\u007f]/.test(next) ? "/" : next;
}

function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array<ArrayBuffer> {
	const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
