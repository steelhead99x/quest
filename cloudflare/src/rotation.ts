// Rotating a session's refresh token exactly once. GitHub's refresh tokens are
// single-use, so two requests refreshing the same session at once, from two
// tabs or two Cloudflare locations, race: the loser's token is refused, and
// signing it out would sign out a valid person. Every refresh of one token goes
// through one coordinator (a Durable Object named after the token), which asks
// GitHub once and hands the same result to every caller.

import { DurableObject } from "cloudflare:workers";
import { refreshOnce, type Refreshed } from "./auth.ts";
import { GitHub, type Fetch } from "./github/client.ts";
import { open, seal, session, type Session } from "./session.ts";

/** Where a coordinator keeps a rotation after it is made, across restarts. */
export interface Ledger {
	get(): Promise<string | undefined>;
	put(sealed: string): Promise<void>;
}

/** How long a rotation is kept for requests still carrying the old token. */
export const KEEP = 10 * 60_000;

/**
 * One refresh token's coordinator logic. Callers that arrive while GitHub is
 * being asked share that answer; callers that arrive later get the kept
 * rotation. A rotation GitHub made is returned even if keeping it fails,
 * since GitHub has already spent the old token.
 */
export class Rotator {
	#pending: Promise<Refreshed> | null = null;
	#made: Refreshed | null = null;

	constructor(
		private readonly ledger: Ledger,
		private readonly secret: string,
		private readonly perform: (s: Session) => Promise<Refreshed>,
	) {}

	rotate(s: Session): Promise<Refreshed> {
		if (this.#made) return Promise.resolve(this.#made);
		this.#pending ??= this.#ask(s).finally(() => (this.#pending = null));
		return this.#pending;
	}

	async #ask(s: Session): Promise<Refreshed> {
		const kept = await this.ledger.get().catch(() => undefined);
		const was = kept ? session(await open(this.secret, "rotation", kept)) : null;
		// Only a rotation of this very session counts; the name could collide only by a hash collision.
		if (was && was.id === s.id) return (this.#made = { kind: "fresh", session: was, changed: true });
		const result = await this.perform(s);
		// An outage may clear up, so only a definite answer is remembered.
		if (result.kind === "unavailable") return result;
		this.#made = result;
		if (result.kind === "fresh")
			try {
				await this.ledger.put(await seal(this.secret, "rotation", result.session));
			} catch (error) {
				console.error("keeping a rotation failed; this instance still serves it", error);
			}
		return result;
	}
}

/** The coordinator's name for a refresh token: its SHA-256, so the token itself never names an object. */
export async function rotationName(refresh: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refresh));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a coordinator reads from the deploy. */
export interface RotationEnv {
	AUTH_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

/**
 * The Durable Object class, over the fetch it reaches GitHub with: the real
 * one in the Worker, the stand-in in the demo.
 */
export function rotationsClass(fetch: () => Fetch) {
	return class Rotations extends DurableObject<RotationEnv> {
		readonly #rotator: Rotator;

		constructor(ctx: DurableObjectState, env: RotationEnv) {
			super(ctx, env);
			const ledger: Ledger = {
				get: () => ctx.storage.get<string>("rotation"),
				put: async (sealed) => {
					await ctx.storage.put("rotation", sealed);
					await ctx.storage.setAlarm(Date.now() + KEEP);
				},
			};
			this.#rotator = new Rotator(ledger, env.AUTH_SECRET, (s) =>
				refreshOnce(
					new GitHub(fetch(), null),
					{ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
					s,
					Date.now(),
				),
			);
		}

		rotate(s: Session): Promise<Refreshed> {
			return this.#rotator.rotate(s);
		}

		/** The old token's callers are long gone: forget the rotation. */
		async alarm() {
			await this.ctx.storage.deleteAll();
		}
	};
}
