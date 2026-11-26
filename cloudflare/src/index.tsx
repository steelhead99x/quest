// The Worker's entry. workerd takes every named export of this module as an
// entrypoint, so it exports only the handler and the Durable Object class;
// the app and its helpers live in app.tsx.
import { app, type Env } from "./app.tsx";
import { rotationName, rotationsClass } from "./rotation.ts";

/** One coordinator per refresh token, so concurrent refreshes spend it once (rotation.ts). */
export const Rotations = rotationsClass(() => (input, init) => fetch(input, init));

type Deployed = Env & { ROTATIONS: DurableObjectNamespace<InstanceType<typeof Rotations>> };

export default app({
	fetch: (input, init) => fetch(input, init),
	now: () => Date.now(),
	cache: async () => caches.default,
	rotate: async (env, s) => {
		const ns = (env as Deployed).ROTATIONS;
		return ns.get(ns.idFromName(await rotationName(s.refresh))).rotate(s);
	},
});
