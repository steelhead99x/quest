// The Worker's entry. workerd takes every named export of this module as an
// entrypoint, so it exports only the handler and the Durable Object class;
// the app and its helpers live in app.tsx.
import { app, type Env } from "./app.tsx";
import type { Session } from "./session.ts";
import { rotationsClass } from "./rotation.ts";

/** One coordinator per sign-in, where its refreshes and sign-out meet (rotation.ts). */
export const Rotations = rotationsClass(() => (input, init) => fetch(input, init));

type Deployed = Env & { ROTATIONS: DurableObjectNamespace<InstanceType<typeof Rotations>> };
const coordinator = (env: Env, s: Session) => {
	const ns = (env as Deployed).ROTATIONS;
	return ns.get(ns.idFromName(s.sid));
};

export default app({
	fetch: (input, init) => fetch(input, init),
	now: () => Date.now(),
	cache: async () => caches.default,
	rotate: (env, s) => coordinator(env, s).rotate(s),
	end: (env, s) => coordinator(env, s).end(s),
});
