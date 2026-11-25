// The demo Worker: the real app, with the stand-in GitHub from github.ts as its
// fetch. GitHub's sign-in page is the one thing a browser visits itself, so the
// demo answers it at /demo/authorize, which sends the browser straight back
// with a code. Nothing here ships in the real Worker (src/index.tsx).

import snapshot from "./snapshot.gen.js";
import { app, type Env } from "../src/app.tsx";
import { github } from "./github.ts";

const AUTHORIZE = "https://github.com/login/oauth/authorize";

// Built on the first request: outside one, a Worker's clock reads 1970.
let real: ReturnType<typeof app> | null = null;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/demo/authorize") {
			const back = new URL("/auth/callback", url.origin);
			back.searchParams.set("code", "demo");
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			return Response.redirect(back.href, 302);
		}
		real ??= app({
			fetch: github(snapshot, () => Date.now()).fetch,
			now: () => Date.now(),
			cache: async () => null,
		});
		const response = await real.fetch(request, env, ctx);
		const location = response.headers.get("location");
		if (location?.startsWith(AUTHORIZE)) {
			const to = new URL(location);
			const local = new URL("/demo/authorize", url.origin);
			local.search = to.search;
			const headers = new Headers(response.headers);
			headers.set("location", local.href);
			return new Response(null, { status: response.status, headers });
		}
		return response;
	},
};
