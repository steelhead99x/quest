// The coordinator: its logic on a clock tests move, then the real Durable
// Object in workerd. Its GitHub calls through the Worker are covered in
// auth.test.ts; here the real object only serves what storage already holds,
// so it never reaches the network.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { Refreshed } from "../../src/auth.ts";
import { type Actions, Coordinator, KEEP, rotationName, type State } from "../../src/rotation.ts";
import { seal, type Session } from "../../src/session.ts";

const old: Session = {
	sid: "00000000-0000-4000-8000-000000000007",
	id: 7,
	login: "octo",
	token: "ghu_one",
	expires: Date.UTC(2026, 10, 25, 12),
	refresh: "ghr_one",
	refreshExpires: Date.UTC(2027, 4, 1),
};
const next: Session = { ...old, token: "ghu_two", refresh: "ghr_two", expires: Date.UTC(2026, 10, 25, 20) };

/** A coordinator on a movable clock, whose GitHub rotates into `next` and records revocations. */
function coordinator() {
	let now = Date.UTC(2026, 10, 25, 12);
	let stored: State | undefined;
	let unreadable = 0;
	const calls = { refresh: 0, revoked: [] as string[] };
	let release: (() => void) | null = null;
	const act: Actions = {
		refresh: async (): Promise<Refreshed> => {
			calls.refresh++;
			if (release === null) await new Promise<void>((r) => (release = r));
			return { kind: "fresh", session: next, changed: true };
		},
		revoke: async (token) => void calls.revoked.push(token),
		now: () => now,
	};
	const c = new Coordinator(
		{
			load: async () => {
				if (unreadable > 0) {
					unreadable--;
					throw new Error("storage read failed");
				}
				return structuredClone(stored);
			},
			save: async (s) => void (stored = structuredClone(s)),
			wake: async () => undefined,
		},
		env.AUTH_SECRET,
		act,
	);
	return {
		c,
		calls,
		stored: () => stored,
		/** Fail the next `n` storage reads. */
		failReads: (n: number) => (unreadable = n),
		advance: (ms: number) => (now += ms),
		/** Let GitHub answer the refresh that is waiting, and every later one at once. */
		answer: () => {
			const r = release;
			release = () => undefined;
			r?.();
		},
	};
}

describe("the coordinator", () => {
	test("a refresh still at GitHub when the session ends is refused, and its new token revoked", async () => {
		const k = coordinator();
		const refreshing = k.c.rotate(old);
		await new Promise((r) => setTimeout(r, 0));
		await k.c.end(old);
		k.answer();
		expect(await refreshing).toEqual({ kind: "revoked" });
		expect(k.calls.revoked.sort()).toEqual(["ghu_one", "ghu_two"]);
		// And any later refresh of the ended session is refused without asking GitHub.
		expect(await k.c.rotate(next)).toEqual({ kind: "revoked" });
		expect(k.calls.refresh).toBe(1);
	});

	test("a sign-out while a new rotation is being sealed revokes the new token and refuses the refresh", async () => {
		const k = coordinator();
		const refreshing = k.c.rotate(old);
		await new Promise((r) => setTimeout(r, 0));
		// GitHub answers, and the sign-out arrives while the coordinator seals the new session.
		k.answer();
		// Let the refresh pass its first check and start sealing, then sign out.
		for (let i = 0; i < 4; i++) await Promise.resolve();
		const ending = k.c.end(old);
		const [result] = await Promise.all([refreshing, ending]);
		expect(result).toEqual({ kind: "revoked" });
		expect(k.calls.revoked.sort()).toEqual(["ghu_one", "ghu_two"]);
		expect(k.stored()?.rotations).toEqual({});
	});

	test("an unreadable store refuses to refresh, without asking GitHub, and reads again next time", async () => {
		const k = coordinator();
		k.answer();
		k.failReads(1);
		await expect(k.c.rotate(old)).rejects.toThrow("can't read");
		expect(k.calls.refresh).toBe(0);
		expect((await k.c.rotate(old)).kind).toBe("fresh");
		expect(k.calls.refresh).toBe(1);
	});

	test("an unreadable store still records a sign-out, so the session can't refresh afterwards", async () => {
		const k = coordinator();
		k.answer();
		k.failReads(1);
		await k.c.end(old);
		expect(k.stored()?.ended).toBeGreaterThan(0);
		expect(await k.c.rotate(old)).toEqual({ kind: "revoked" });
		expect(k.calls.refresh).toBe(0);
	});

	test("ending revokes a rotation that finished just before", async () => {
		const k = coordinator();
		k.answer();
		expect((await k.c.rotate(old)).kind).toBe("fresh");
		await k.c.end(old);
		expect(k.calls.revoked.sort()).toEqual(["ghu_one", "ghu_two"]);
	});

	test("a kept rotation expires on read, and a sweep forgets it here and in storage", async () => {
		const k = coordinator();
		k.answer();
		await k.c.rotate(old);
		expect(await k.c.rotate(old)).toEqual({ kind: "fresh", session: next, changed: true });
		expect(k.calls.refresh).toBe(1);
		k.advance(KEEP + 1);
		// Past its deadline the kept rotation is not served, even before the sweep runs.
		await k.c.rotate(old);
		expect(k.calls.refresh).toBe(2);
		k.advance(KEEP + 1);
		await k.c.sweep();
		expect(k.stored()?.rotations).toEqual({});
	});
});

// The binding comes from the deploy config; only these methods are called through it.
type Stub = DurableObjectStub & { rotate(s: Session): Promise<unknown>; end(s: Session): Promise<void> };
const ns = (env as unknown as { ROTATIONS: DurableObjectNamespace }).ROTATIONS;

describe("the real Durable Object", () => {
	test("serves a kept rotation of this session, and its alarm sweeps it once past", async () => {
		const stub = ns.get(ns.idFromName(old.sid)) as Stub;
		const state: State = {
			ended: null,
			rotations: {
				[await rotationName(old.refresh)]: {
					sealed: await seal(env.AUTH_SECRET, "rotation", next),
					until: Date.now() + 300,
				},
			},
		};
		await runInDurableObject(stub, async (_, ctx) => {
			await ctx.storage.put("state", state);
		});
		expect(await stub.rotate(old)).toEqual({ kind: "fresh", session: next, changed: true });
		await new Promise((r) => setTimeout(r, 400));
		await runInDurableObject(stub, async (_, ctx) => {
			await ctx.storage.setAlarm(Date.now());
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_, ctx) => {
			expect((await ctx.storage.get<State>("state"))?.rotations).toEqual({});
		});
	});
});
