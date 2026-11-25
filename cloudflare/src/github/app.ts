// The GitHub App the Worker signs people in with. It acts only for a signed-in
// person, through their user token, so it needs no webhook or installation key.

/** The repository permissions every user token gets, and no more. */
export const PERMISSIONS = {
	metadata: "read",
	contents: "read",
	pull_requests: "read",
	checks: "read",
	// Re-running a failed workflow run and dispatching a workflow.
	actions: "write",
} as const;

/** The path GitHub sends a signed-in person back to. */
export const CALLBACK = "/auth/callback";

/** What GitHub's manifest flow registers an App from. */
export interface Manifest {
	name: string;
	url: string;
	description: string;
	public: boolean;
	redirect_url: string;
	callback_urls: string[];
	request_oauth_on_install: boolean;
	hook_attributes: { url: string; active: boolean };
	default_permissions: typeof PERMISSIONS;
	default_events: string[];
}

/** The manifest for a deploy at `origin`, whose registration returns to `redirect`. */
export function manifest(origin: string, redirect: string, name: string): Manifest {
	const site = new URL(origin);
	if (site.protocol !== "https:" && site.hostname !== "localhost")
		throw new Error(`${origin} must be https, or localhost for development`);
	if (site.pathname !== "/" || site.search || site.hash) throw new Error(`${origin} must be an origin, with no path`);
	// GitHub's own limit on App names.
	if (name.length === 0 || name.length > 34) throw new Error(`the App name must be 1 to 34 characters: ${name}`);
	return {
		name,
		url: site.origin,
		description: "Quest log: quest stats, PR CI, and re-runs, on any phone.",
		// Installable on any account, so the maintainer's organization can install a contributor's App.
		public: true,
		redirect_url: redirect,
		callback_urls: [site.origin + CALLBACK],
		// Sign-in must start on the Worker so it can bind state to the browser.
		request_oauth_on_install: false,
		// The manifest flow requires a hook URL even when nothing is delivered.
		hook_attributes: { url: site.origin + "/webhooks/github", active: false },
		default_permissions: PERMISSIONS,
		default_events: [],
	};
}

/** The credentials GitHub returns once for a newly registered App. */
export interface Registered {
	id: number;
	slug: string;
	clientId: string;
	clientSecret: string;
	htmlUrl: string;
}

/** Read GitHub's manifest conversion response, refusing one missing what the Worker needs. */
export function registered(body: unknown): Registered {
	if (typeof body !== "object" || body === null) throw new Error("GitHub's App conversion response is not an object");
	const b = body as Record<string, unknown>;
	const text = (key: string): string => {
		const value = b[key];
		if (typeof value !== "string" || value.length === 0 || value.length > 512)
			throw new Error(`GitHub's App conversion response has no usable ${key}`);
		return value;
	};
	if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id <= 0)
		throw new Error("GitHub's App conversion response has no usable id");
	const slug = text("slug");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`GitHub's App slug is malformed: ${slug}`);
	return {
		id: b.id,
		slug,
		clientId: text("client_id"),
		clientSecret: text("client_secret"),
		htmlUrl: text("html_url"),
	};
}
