// The real Durable Object in workerd: what it keeps, and when it forgets.
// Its GitHub call is covered through the harness (auth.test.ts); here storage
// already holds a rotation, so the object never reaches the network.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { KEEP, rotationName } from "../../src/rotation.ts";
import { seal, type Session } from "../../src/session.ts";

const old: Session = {
	id: 7,
	login: "octo",
	token: "ghu_one",
	expires: Date.UTC(2026, 10, 25, 12),
	refresh: "ghr_one",
	refreshExpires: Date.UTC(2027, 4, 1),
};
const next: Session = { ...old, token: "ghu_two", refresh: "ghr_two", expires: Date.UTC(2026, 10, 25, 20) };

// The binding comes from the deploy config; only `rotate` is called through it.
type Stub = DurableObjectStub & { rotate(s: Session): Promise<unknown> };
const ns = (env as unknown as { ROTATIONS: DurableObjectNamespace }).ROTATIONS;

describe("the rotation coordinator", () => {
	test("hands out a kept rotation of this session, and forgets it when its alarm fires", async () => {
		const stub = ns.get(ns.idFromName(await rotationName(old.refresh))) as Stub;
		await runInDurableObject(stub, async (_, state) => {
			await state.storage.put("rotation", await seal(env.AUTH_SECRET, "rotation", next));
			await state.storage.setAlarm(Date.now() + KEEP);
		});
		expect(await stub.rotate(old)).toEqual({ kind: "fresh", session: next, changed: true });
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_, state) => {
			expect(await state.storage.get("rotation")).toBeUndefined();
		});
	});

	test("names an object by the token's hash, never the token", async () => {
		const name = await rotationName("ghr_one");
		expect(name).toMatch(/^[0-9a-f]{64}$/);
		expect(name).not.toContain("ghr_one");
	});
});
