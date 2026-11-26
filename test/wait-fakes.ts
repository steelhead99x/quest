// A fake GitHub for `quest wait`: scripted REST pages and GraphQL answers, and a clock that advances as it sleeps.
import { type CachedResponse, type GitHubReadDependencies } from "../src/github/client";
import { GitHubForge } from "../src/github/forge";
import { waitForActivity, type WaitOptions } from "../src/cli/wait";

export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const C = "c".repeat(40);
export const POINT = "2026-10-07T12:00:00Z";
export const pr = { owner: "example", repo: "project", number: 1 };
export const base = "/repos/example/project";
export const timeline = `${base}/issues/1/timeline?per_page=100`;
/** The GitHub Actions app, which reports workflow check runs. */
export const ACTIONS = 15368;

export function response(body: unknown, headers?: Record<string, string>, status = 200): Response {
	return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

export function pull(headRepo: unknown = { full_name: "contributor/fork" }, sha = A) {
	return response({ base: { sha: C }, head: { sha, ref: "feature/a", repo: headRepo } });
}

export function pushed(after = A, time = POINT, type = "push") {
	return { activity_type: type, after, timestamp: time, actor: { login: "author" } };
}

export function committed(sha: string) {
	return {
		event: "committed",
		sha,
		committer: { name: "A Person", date: "2000-01-01T00:00:00Z" },
		html_url: `https://github.com/example/project/commit/${sha}`,
	};
}

export function reviewed(id = 1, time = POINT) {
	return {
		event: "reviewed",
		id,
		submitted_at: time,
		user: { login: "reviewer" },
		html_url: `https://github.com/example/project/pull/1#pullrequestreview-${id}`,
	};
}

export function reactions(
	pull: unknown[] = [],
	reviews: unknown[] = [],
	page: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) {
	return response({
		data: {
			viewer: { login: "waiter" },
			repository: { pullRequest: { reactions: { nodes: pull }, reviews: { pageInfo: page, nodes: reviews } } },
		},
	});
}

export function reacted(id: string, time = POINT, login = "codex[bot]", content = "THUMBS_UP") {
	return { id, content, createdAt: time, user: { login } };
}

export function replied(id: number, time = POINT, login = "reviewer", inReplyTo: number | null = 1) {
	return {
		id,
		in_reply_to_id: inReplyTo,
		created_at: time,
		user: { login },
		html_url: `https://github.com/example/project/pull/1#discussion_r${id}`,
	};
}

export interface CheckFixture {
	name: string;
	required?: boolean;
	/** A check run's conclusion, or a commit status's state; omitted while it runs. */
	result?: string;
	time?: string;
	status?: boolean;
	/** The workflow file a job runs in, and whether its run is still going, so it may yet create jobs. */
	workflow?: string;
	running?: boolean;
	/** A check run's ID, which grows with each run; its place in the page by default. */
	id?: number;
	/** The app behind a check run; GitHub Actions by default. */
	app?: number;
	/** The check suite of the workflow run behind a check run. */
	suite?: number;
}

/** The head's checks; `null` means the head has no checks at all. */
export function checks(
	contexts: CheckFixture[] | null = null,
	head = A,
	page: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
	listed = head,
	extra: Record<string, unknown> = {},
) {
	const node = (entry: CheckFixture, index: number) =>
		entry.status
			? {
					__typename: "StatusContext",
					context: entry.name,
					state: entry.result ?? "PENDING",
					createdAt: entry.time ?? POINT,
					targetUrl: null,
					isRequired: entry.required ?? false,
				}
			: {
					__typename: "CheckRun",
					databaseId: entry.id ?? index + 1,
					name: entry.name,
					status: entry.result ? "COMPLETED" : "IN_PROGRESS",
					conclusion: entry.result ?? null,
					completedAt: entry.result ? (entry.time ?? POINT) : null,
					detailsUrl: `https://github.com/example/project/actions/runs/1/job/${entry.name.length}`,
					isRequired: entry.required ?? false,
					checkSuite: {
						status: entry.result && !entry.running ? "COMPLETED" : "IN_PROGRESS",
						databaseId: entry.suite ?? null,
						app: { databaseId: entry.app ?? ACTIONS },
						workflowRun: {
							file: {
								path: entry.workflow ?? ".github/workflows/check.yml",
								repositoryName: "example/project",
							},
						},
					},
				};
	return response({
		data: {
			repository: {
				pullRequest: {
					baseRefName: "main",
					headRefOid: head,
					...extra,
					commits: {
						nodes: [
							{
								commit: {
									oid: listed,
									statusCheckRollup: contexts && {
										contexts: { pageInfo: page, nodes: contexts.map(node) },
									},
								},
							},
						],
					},
				},
			},
		},
	});
}

/**
 * Review comments, reactions, and checks come from their own queues, empty once drained.
 * The base branch requires `protected` through branch protection and `ruled` through rulesets,
 * reported by GitHub Actions. `rules` adds further rules on a second page.
 */
export function setup(
	responses: Response[],
	baseline = [A],
	side: {
		comments?: Response[];
		edits?: Response[];
		graphql?: Response[];
		checks?: Response[];
		protected?: string[];
		/** Classic protection that lists only `contexts`, without `checks`. */
		contextsOnly?: boolean;
		ruled?: string[];
		rules?: unknown[];
		/** The head's workflow runs, as `GET /actions/runs` lists them, one listing per read; the last repeats. */
		runs?: unknown[][];
		/** GitHub's answer to the viewer query; `waiter` by default. */
		viewer?: Response;
	} = {},
) {
	let now = Date.parse("2026-10-07T12:10:00Z");
	const calls: { path: string; headers: Headers }[] = [];
	const sideCalls: { path: string; headers: Headers; body?: unknown }[] = [];
	const checkCalls: { path: string; headers: Headers; body?: unknown }[] = [];
	const editCalls: { path: string; headers: Headers }[] = [];
	const ruleCalls: { path: string; headers: Headers }[] = [];
	const sleeps: number[] = [];
	const warnings: string[] = [];
	const stored = new Map<string, CachedResponse>();
	const deps: GitHubReadDependencies = {
		readToken: "test-token",
		quota: "wait",
		cache: { get: async (key) => stored.get(key), set: async (key, entry) => void stored.set(key, entry) },
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		warn: (text) => warnings.push(text),
		fetch: async (url, init) => {
			const parsed = new URL(String(url));
			const call = { path: parsed.pathname + parsed.search, headers: new Headers(init?.headers) };
			if (parsed.pathname.endsWith("/issues/1/comments")) {
				editCalls.push(call);
				return side.edits?.shift() ?? response([]);
			}
			if (parsed.pathname.endsWith("/pulls/1/comments")) {
				sideCalls.push(call);
				return side.comments?.shift() ?? response([]);
			}
			if (parsed.pathname === "/graphql") {
				const body = JSON.parse(String(init?.body)) as { query: string };
				if (body.query === "query { viewer { login } }")
					return side.viewer ?? response({ data: { viewer: { login: "waiter" } } });
				if (body.query.includes("statusCheckRollup")) {
					checkCalls.push({ ...call, body });
					return side.checks?.shift() ?? checks();
				}
				sideCalls.push({ ...call, body });
				return side.graphql?.shift() ?? reactions();
			}
			if (parsed.pathname === "/repositories/1") return Response.json({ full_name: "example/project" });
			if (parsed.pathname === `${base}/branches/main`) {
				ruleCalls.push(call);
				const contexts = side.protected ?? [];
				const checks = contexts.map((context) => ({ context, app_id: null }));
				const level = contexts.length ? "everyone" : "off";
				return response({
					protection: {
						enabled: contexts.length > 0,
						required_status_checks: side.contextsOnly
							? { enforcement_level: level, contexts }
							: { enforcement_level: level, checks },
					},
				});
			}
			if (parsed.pathname === `${base}/actions/runs` && side.runs) {
				ruleCalls.push(call);
				const listed = side.runs.length > 1 ? side.runs.shift()! : side.runs[0]!;
				return response({ total_count: listed.length, workflow_runs: listed });
			}
			if (parsed.pathname === `${base}/rules/branches/main`) {
				ruleCalls.push(call);
				if (parsed.searchParams.get("page") === "2") return response(side.rules);
				const checks = (side.ruled ?? []).map((context) => ({ context, integration_id: ACTIONS }));
				const next = `<https://api.github.com${base}/rules/branches/main?per_page=100&page=2>; rel="next"`;
				return response(
					[
						{ type: "deletion" },
						...(checks.length
							? [{ type: "required_status_checks", parameters: { required_status_checks: checks } }]
							: []),
					],
					side.rules ? { link: next } : undefined,
				);
			}
			calls.push(call);
			if (parsed.pathname.endsWith("/commits")) return response(baseline.map((sha) => ({ sha })));
			const next = responses.shift();
			if (!next) throw new Error(`unexpected request: ${parsed.pathname + parsed.search}`);
			return next;
		},
	};
	return { deps, calls, sideCalls, checkCalls, editCalls, ruleCalls, sleeps, warnings, responses };
}

/** Wait on GitHub, with the fixture's clock. */
export function waitOn(pull: typeof pr, options: WaitOptions, deps: GitHubReadDependencies): Promise<string[]> {
	return waitForActivity(pull, options, { choose: async () => new GitHubForge(deps) }, deps);
}

export function graphql(fixture: ReturnType<typeof setup>) {
	return fixture.sideCalls
		.filter((call) => call.path === "/graphql")
		.map((call) => call.body as { variables: Record<string, unknown> });
}

export function cursor(lines: string[]): string {
	return lines.at(-1)!.split(" ").at(-1)!;
}
