import { expect, test } from "vitest";
import demo from "../../demo/index.ts";
import { env } from "./fake.ts";

/** Follow the demo's redirects as a browser would, carrying its cookies. */
async function browse(path: string, jar: Map<string, string>, init: RequestInit = {}): Promise<Response> {
	let url = `https://demo.test${path}`;
	for (let hops = 0; hops < 10; hops++) {
		const headers = new Headers(init.headers);
		headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
		const response = await demo.fetch(
			new Request(url, { ...init, headers, redirect: "manual" }),
			env,
			{} as ExecutionContext,
		);
		for (const line of response.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split("; ");
			const [name, value] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
			if (attrs.includes("Max-Age=0")) jar.delete(name);
			else jar.set(name, value);
		}
		const to = response.headers.get("location");
		if (!to || response.status < 300 || response.status >= 400) return response;
		url = new URL(to, url).href;
		init = {};
	}
	throw new Error("too many redirects");
}

test("the demo signs in through its stand-in GitHub and serves every page and action", async () => {
	const jar = new Map<string, string>();
	const board = await browse("/sign-in?next=%2Frepos%2Fsteelhead99x%2Fquest", jar);
	const html = await board.text();
	expect(html).toContain('<span class="muted">demo</span>');
	expect(html).toContain('<li class="stat stat-review"><strong class="stat-value">1</strong>');
	expect(html).toContain("CI on main");
	const quest =
		/href="(\/repos\/steelhead99x\/quest\/quest\/[^"]+)"><\/a>|class="entry-title" href="([^"]+)">[^<]*<\/a><span class="entry-meta">(?:<span class="ql-size[^>]*>[^<]*<\/span>)?<span class="entry-status ql-review">/.exec(
			html,
		);
	const href = quest?.[1] ?? quest?.[2];
	expect(href).toBeTruthy();
	const page = await (await browse(href!, jar)).text();
	expect(page).toContain("Re-run failed jobs");
	const id = /\/runs\/(\d+)\/rerun/.exec(page)![1];
	const form = {
		method: "POST",
		headers: { origin: "https://demo.test", "content-type": "application/x-www-form-urlencoded" },
		body: "next=%2F",
	};
	expect(await (await browse(`/repos/steelhead99x/quest/runs/${id}/rerun`, jar, form)).text()).toContain(
		"Re-run started",
	);
	const file = /\/workflows\/([^/]+)\/dispatch/.exec(html)![1];
	expect(await (await browse(`/repos/steelhead99x/quest/workflows/${file}/dispatch`, jar, form)).text()).toContain(
		"Workflow started",
	);
	expect(await (await browse("/repos/steelhead99x/quest/bench", jar)).text()).toContain("By writer");
});
