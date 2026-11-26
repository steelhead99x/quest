// One coordinator per sign-in, where its refreshes and its sign-out meet.
//
// GitHub's refresh tokens are single-use, so two requests refreshing one
// session at once, from two tabs or two Cloudflare locations, race: the
// loser's token is refused, and signing it out would sign out a valid person.
// And a refresh still in flight when the person signs out would hand them a
// new session afterwards. Every refresh and the sign-out of one session go
// through one coordinator (a Durable Object named by the session's id), which
// asks GitHub once per refresh token, hands every caller the same result, and
// once the session has ended refuses to refresh it and revokes what it made.

import { DurableObject } from "cloudflare:workers";
import { type Config, refreshOnce, type Refreshed, revoke } from "./auth.ts";
import { GitHub, type Fetch } from "./github/client.ts";
import { open, seal, session, type Session } from "./session.ts";

/** How long a rotation is kept for requests still carrying the old refresh token. */
export const KEEP = 10 * 60_000;

/** What a coordinator keeps, each entry until its deadline (ms since the epoch). */
export interface State {
	/** The session was signed out; refreshes are refused until its refresh token would have expired. */
	ended: number | null;
	/** Rotations by the SHA-256 of the refresh token they replaced, sealed. */
	rotations: Record<string, { sealed: string; until: number }>;
}

/** Where a coordinator keeps its state across restarts, and when to wake to sweep it. */
export interface Store {
	load(): Promise<State | undefined>;
	save(state: State): Promise<void>;
	/** Wake at `at` to sweep, or never for null. */
	wake(at: number | null): Promise<void>;
}

/** What a coordinator does with GitHub, and its clock. */
export interface Actions {
	refresh(s: Session): Promise<Refreshed>;
	revoke(token: string): Promise<void>;
	now(): number;
}

/** A refresh token's name in the state: its SHA-256, so no token is ever a key. */
export async function rotationName(refresh: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refresh));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One session's coordinator logic, apart from the Durable Object around it. */
export class Coordinator {
	/** The state, held in memory once loaded: a failed save still leaves this instance serving it. */
	#state: State | null = null;
	readonly #pending = new Map<string, Promise<Refreshed>>();

	constructor(
		private readonly store: Store,
		private readonly secret: string,
		private readonly act: Actions,
	) {}

	/** Refresh `s`, once for every caller carrying the same refresh token, and never after `end`. */
	async rotate(s: Session): Promise<Refreshed> {
		const key = await rotationName(s.refresh);
		let pending = this.#pending.get(key);
		if (!pending) {
			pending = this.#rotate(s, key).finally(() => this.#pending.delete(key));
			this.#pending.set(key, pending);
		}
		return pending;
	}

	async #rotate(s: Session, key: string): Promise<Refreshed> {
		const state = await this.#load();
		if (this.#ended(state)) return { kind: "revoked" };
		const kept = state.rotations[key];
		if (kept && kept.until > this.act.now()) {
			const was = session(await open(this.secret, "rotation", kept.sealed));
			if (was && was.sid === s.sid) return { kind: "fresh", session: was, changed: true };
		}
		const result = await this.act.refresh(s);
		if (result.kind !== "fresh") return this.#ended(state) ? { kind: "revoked" } : result;
		const sealed = await seal(this.secret, "rotation", result.session);
		// Signed out while GitHub answered or while sealing: the new token must not outlive the
		// session. Nothing is awaited between this check and publishing the rotation, so a
		// sign-out either sees the rotation (and revokes it) or is seen here.
		if (this.#ended(state)) {
			await this.#revoke(result.session.token);
			return { kind: "revoked" };
		}
		state.rotations[key] = { sealed, until: this.act.now() + KEEP };
		await this.#save(state, "keeping a rotation");
		return result;
	}

	/**
	 * End the session: refuse every later refresh, and revoke the token signing
	 * out carried and every token this coordinator rotated into, so a refresh
	 * that finished just before cannot keep the person signed in.
	 */
	async end(s: Session): Promise<void> {
		const until = Math.max(s.refreshExpires, this.act.now() + KEEP);
		let state: State;
		try {
			state = await this.#load();
		} catch {
			// The stored state can't be read, so its rotations can't be revoked; still record the
			// sign-out, which is what keeps the session from refreshing again.
			state = this.#state = this.#state ?? { ended: null, rotations: {} };
		}
		// Mark the session ended and take its rotations in one step, with nothing awaited between,
		// so a refresh publishing a rotation either lands before (and is revoked here) or sees this.
		state.ended = Math.max(state.ended ?? 0, until);
		const kept = Object.values(state.rotations);
		state.rotations = {};
		const tokens = new Set([s.token]);
		for (const { sealed } of kept) {
			const made = session(await open(this.secret, "rotation", sealed));
			if (made) tokens.add(made.token);
		}
		await this.#save(state, "ending a session");
		await Promise.all([...tokens].map((t) => this.#revoke(t)));
	}

	/** Drop what has passed its deadline, here and in storage, and wake for the next. */
	async sweep(): Promise<void> {
		const state = await this.#load();
		const now = this.act.now();
		for (const [key, kept] of Object.entries(state.rotations)) if (kept.until <= now) delete state.rotations[key];
		if (state.ended !== null && state.ended <= now) state.ended = null;
		await this.#save(state, "sweeping");
	}

	#ended(state: State): boolean {
		return state.ended !== null && state.ended > this.act.now();
	}

	/**
	 * The state, read from storage once. A read that fails is not taken as empty: that would
	 * forget a sign-out. It throws, so the caller answers "unavailable", and the next call reads again.
	 */
	async #load(): Promise<State> {
		if (!this.#state) {
			let stored: State | undefined;
			try {
				stored = await this.store.load();
			} catch (error) {
				throw new Error("the coordinator can't read its storage", { cause: error });
			}
			this.#state = this.#state ?? stored ?? { ended: null, rotations: {} };
		}
		return this.#state;
	}

	async #save(state: State, doing: string): Promise<void> {
		const deadlines = [...Object.values(state.rotations).map((r) => r.until), state.ended ?? Infinity];
		const next = Math.min(...deadlines);
		try {
			await this.store.save(state);
			await this.store.wake(Number.isFinite(next) ? next : null);
		} catch (error) {
			console.error(`${doing} failed to reach storage; this instance still holds it`, error);
		}
	}

	async #revoke(token: string): Promise<void> {
		await this.act.revoke(token).catch((error) => console.error("revoking a token failed", error));
	}
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
		readonly #coordinator: Coordinator;

		constructor(ctx: DurableObjectState, env: RotationEnv) {
			super(ctx, env);
			const config: Config = {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
				origin: "",
			};
			const github = () => new GitHub(fetch(), null);
			this.#coordinator = new Coordinator(
				{
					load: () => ctx.storage.get<State>("state"),
					save: (state) => ctx.storage.put("state", state),
					wake: (at) => (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
				},
				env.AUTH_SECRET,
				{
					refresh: (s) => refreshOnce(github(), config, s, Date.now()),
					revoke: (token) => revoke(github(), config, token),
					now: () => Date.now(),
				},
			);
		}

		rotate(s: Session): Promise<Refreshed> {
			return this.#coordinator.rotate(s);
		}

		end(s: Session): Promise<void> {
			return this.#coordinator.end(s);
		}

		async alarm() {
			await this.#coordinator.sweep();
		}
	};
}
