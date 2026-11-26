// Take a Chrome browser fully offline: the page and every service worker. The
// DevTools offline switch on a page leaves a service worker's own fetches on
// the network, so an offline check through it alone passes whether or not
// the worker serves from its cache.

import { Rpc } from "./rpc.ts";

/** The page's and each service worker's network, switched together through the browser's DevTools endpoint. */
export class Offline {
	private constructor(
		private readonly browser: Rpc,
		private readonly sessions: string[],
	) {}

	/** Attach to every service worker the browser runs, through its DevTools port. */
	static async attach(port: number, timeout: number): Promise<Offline> {
		const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
			webSocketDebuggerUrl?: string;
		};
		if (!version.webSocketDebuggerUrl) throw new Error("Chrome's DevTools port has no browser endpoint");
		const browser = await Rpc.connect(version.webSocketDebuggerUrl, timeout);
		const { targetInfos } = (await browser.call("Target.getTargets")) as {
			targetInfos: { targetId: string; type: string }[];
		};
		const sessions: string[] = [];
		for (const t of targetInfos.filter((t) => t.type === "service_worker")) {
			const { sessionId } = (await browser.call("Target.attachToTarget", {
				targetId: t.targetId,
				flatten: true,
			})) as {
				sessionId: string;
			};
			await browser.call("Network.enable", {}, sessionId);
			sessions.push(sessionId);
		}
		return new Offline(browser, sessions);
	}

	/** How many service workers this switches, so a check can refuse to run with none. */
	get workers(): number {
		return this.sessions.length;
	}

	/** Switch each attached service worker's network off or on. */
	async set(offline: boolean): Promise<void> {
		for (const session of this.sessions)
			await this.browser.call(
				"Network.emulateNetworkConditions",
				{ offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
				session,
			);
	}

	close(): void {
		this.browser.close();
	}
}
