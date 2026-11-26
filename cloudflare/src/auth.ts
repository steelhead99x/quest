// Signing in with the GitHub App's user-to-server OAuth: send the person to
// GitHub with a state bound to a sealed cookie, exchange the code for a user
// token and its refresh token, and refresh the token when it expires.

import { CALLBACK } from "./github/app.ts";
import { bounded, type GitHub } from "./github/client.ts";
import type { Session } from "./session.ts";

/** Refresh a token this close to expiring, so a page never starts with one about to lapse. */
export const EARLY = 60_000;

/** The deploy's sign-in configuration. */
export interface Config {
	clientId: string;
	clientSecret: string;
	origin: string;
}

/** Where to send a person to sign in, with `state` to check on return. */
export function authorizeUrl(config: Config, state: string): string {
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("redirect_uri", config.origin + CALLBACK);
	url.searchParams.set("state", state);
	// A GitHub App's permissions come from its registration, not OAuth scopes.
	url.searchParams.set("allow_signup", "false");
	return url.href;
}

/** GitHub's token answer, refusing one without the tokens and expiries a GitHub App issues. */
export function tokens(body: unknown, now: number): Pick<Session, "token" | "expires" | "refresh" | "refreshExpires"> {
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	if (typeof b.error === "string")
		throw new Error(`GitHub refused the sign-in: ${String(b.error_description ?? b.error)}`);
	const { access_token, refresh_token, expires_in, refresh_token_expires_in } = b;
	if (typeof access_token !== "string" || typeof refresh_token !== "string")
		throw new Error(
			"GitHub returned no refresh token: turn on expiring user tokens in the App's settings (Optional features)",
		);
	if (typeof expires_in !== "number" || typeof refresh_token_expires_in !== "number")
		throw new Error("GitHub returned tokens without their expiries");
	return {
		token: access_token,
		expires: now + expires_in * 1000,
		refresh: refresh_token,
		refreshExpires: now + refresh_token_expires_in * 1000,
	};
}

/** Exchange a sign-in's code for a session. */
export async function exchange(github: GitHub, config: Config, code: string, now: number): Promise<Session> {
	const issued = tokens(
		await post(github, {
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			redirect_uri: config.origin + CALLBACK,
		}),
		now,
	);
	const user = await github.withToken(issued.token).get<{ id: number; login: string }>("/user");
	if (!Number.isSafeInteger(user.id) || typeof user.login !== "string") throw new Error("GitHub returned no user");
	return { id: user.id, login: user.login, ...issued };
}

/** What refreshing a session came to. */
export type Refreshed =
	/** The token is current, or was just rotated, by this request or a concurrent one. */
	| { kind: "fresh"; session: Session; changed: boolean }
	/** GitHub refused the refresh token: it was revoked or expired. */
	| { kind: "revoked" }
	/** GitHub could not be asked or answered oddly: the session stays, and its token is used while valid. */
	| { kind: "unavailable" };

/** GitHub's answer for a refresh token that will never work again. */
const REVOKED = "bad_refresh_token";

/**
 * The session with a fresh token if it is about to expire. `rotate` asks
 * GitHub through the token's coordinator (rotation.ts), so concurrent
 * refreshes of one session, from any location, spend its token once.
 */
export async function refreshed(
	s: Session,
	now: number,
	rotate: (s: Session) => Promise<Refreshed>,
): Promise<Refreshed> {
	if (s.expires - EARLY > now) return { kind: "fresh", session: s, changed: false };
	if (s.refreshExpires <= now) return { kind: "revoked" };
	try {
		return await rotate(s);
	} catch (error) {
		console.error("the rotation coordinator failed", error);
		return { kind: "unavailable" };
	}
}

/** Ask GitHub once to rotate a session's refresh token. Only `bad_refresh_token` counts as refused. */
export async function refreshOnce(
	github: GitHub,
	config: Pick<Config, "clientId" | "clientSecret">,
	s: Session,
	now: number,
): Promise<Refreshed> {
	try {
		const answer = (await post(github, {
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: "refresh_token",
			refresh_token: s.refresh,
		})) as Record<string, unknown>;
		if (answer?.error === REVOKED) return { kind: "revoked" };
		return { kind: "fresh", session: { ...s, ...tokens(answer, now) }, changed: true };
	} catch {
		return { kind: "unavailable" };
	}
}

/** Revoke a signed-out session's token, so a copied cookie stops working on GitHub too. */
export async function revoke(github: GitHub, config: Config, token: string): Promise<void> {
	const response = await github.raw(`https://api.github.com/applications/${config.clientId}/token`, {
		method: "DELETE",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
			"user-agent": "quest-cloudflare",
			"content-type": "application/json",
		},
		body: JSON.stringify({ access_token: token }),
	});
	// 404: already revoked or expired, which is what signing out wants.
	if (!response.ok && response.status !== 404) throw new Error(`GitHub did not revoke the token: ${response.status}`);
}

async function post(github: GitHub, form: Record<string, string>): Promise<unknown> {
	const response = await github.raw("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form),
	});
	const text = await bounded(response, 64 * 1024);
	if (!response.ok) throw new Error(`GitHub's token endpoint answered ${response.status}`);
	return JSON.parse(text);
}
