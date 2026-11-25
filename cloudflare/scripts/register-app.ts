// Register the Worker's GitHub App through GitHub's manifest flow: serve a page
// on localhost that posts the manifest to GitHub, take GitHub's redirect back
// with a one-time code, exchange it for the App's credentials, and write them
// where `wrangler secret bulk` reads them.
//
//   bun scripts/register-app.ts --origin https://quest.example.dev [--name N] [--org O] [--out F]

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { manifest, type Registered, registered } from "../src/github/app.ts";

const { values } = parseArgs({
	options: {
		origin: { type: "string" },
		name: { type: "string" },
		org: { type: "string" },
		out: { type: "string", default: ".github-app.json" },
		port: { type: "string", default: "8788" },
	},
	strict: true,
});
if (!values.origin) throw new Error("--origin is required, such as --origin https://quest.example.dev");
if (existsSync(values.out)) throw new Error(`${values.out} exists; move it away rather than overwrite credentials`);
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--port is not a port: ${values.port}`);

const host = new URL(values.origin).hostname;
const name = values.name ?? `Quest ${host}`.slice(0, 34);
const redirect = `http://localhost:${port}/callback`;
// Built before serving, so a bad origin or name fails here rather than on the first page load.
const json = JSON.stringify(manifest(values.origin, redirect, name));
const state = crypto.randomUUID();
const target = values.org
	? `https://github.com/organizations/${encodeURIComponent(values.org)}/settings/apps/new`
	: "https://github.com/settings/apps/new";

const app = await new Promise<Registered>((resolve, reject) => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/") return page(target, state, json);
			if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
			if (url.searchParams.get("state") !== state) return new Response("State mismatch", { status: 400 });
			const code = url.searchParams.get("code");
			if (!code || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) return new Response("No code", { status: 400 });
			try {
				const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
					method: "POST",
					headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
				});
				if (!response.ok)
					throw new Error(`GitHub refused the conversion: ${response.status} ${await response.text()}`);
				const done = registered(await response.json());
				resolve(done);
				setTimeout(() => server.stop(), 100);
				return new Response(`Registered ${done.slug}. You can close this tab.`);
			} catch (error) {
				reject(error);
				setTimeout(() => server.stop(), 100);
				return new Response(String(error), { status: 502 });
			}
		},
	});
	console.log(`Open http://localhost:${port}/ in a browser signed in to GitHub, and press Create.`);
});

// Only what the Worker reads; the App's private key is never needed, since it acts through user tokens.
writeFileSync(
	values.out,
	JSON.stringify({ GITHUB_CLIENT_ID: app.clientId, GITHUB_CLIENT_SECRET: app.clientSecret }, null, "\t") + "\n",
	{ mode: 0o600 },
);
chmodSync(values.out, 0o600);
console.log(`Registered ${app.htmlUrl} (id ${app.id}).`);
console.log(`Set GITHUB_APP_SLUG to "${app.slug}" in wrangler.jsonc's vars, then run:`);
console.log(`  bunx wrangler secret bulk ${values.out} && rm ${values.out}`);

/** A page that posts the manifest to GitHub as soon as it loads. */
function page(action: string, state: string, json: string): Response {
	const escape = (s: string) =>
		s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Register the Quest App</title>
<form method="post" action="${escape(action)}?state=${escape(state)}">
<input type="hidden" name="manifest" value="${escape(json)}">
<button>Register the App on GitHub</button></form>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}
