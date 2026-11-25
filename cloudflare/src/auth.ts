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

/** The session with a fresh token if it is about to expire, or null once it cannot be refreshed. */
export async function refreshed(github: GitHub, config: Config, s: Session, now: number): Promise<Session | null> {
	if (s.expires - EARLY > now) return s;
	if (s.refreshExpires <= now) return null;
	try {
		const issued = tokens(
			await post(github, {
				client_id: config.clientId,
				client_secret: config.clientSecret,
				grant_type: "refresh_token",
				refresh_token: s.refresh,
			}),
			now,
		);
		return { ...s, ...issued };
	} catch {
		// A revoked or reused refresh token: sign out rather than retry.
		return null;
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
