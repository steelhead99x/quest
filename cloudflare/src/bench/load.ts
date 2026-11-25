// Load merged quest PRs for the bench page in one GraphQL request: each PR's
// body (for its `## Models` and `## Review` records), when it opened and
// merged, and its head commit's check runs, for CI wall time.

import type { GitHub } from "../github/client.ts";

/** Merged PRs read, newest first, then filtered to quest branches in the window. */
export const MAX_MERGED = 50;
/** The window the page covers, in days. */
export const WINDOW_DAYS = 30;
/** The most bytes the answer may hold: fifty PR bodies and their check runs. */
export const MAX_ANSWER = 12 * 1024 * 1024;

/** One merged PR, as the bench reads it. */
export interface Merged {
	number: number;
	url: string;
	title: string;
	branch: string;
	body: string;
	created: string;
	merged: string;
	/** Each check run's start and finish on the head commit. */
	checks: { started: string | null; completed: string | null }[];
}

/** The PRs, and whether older merges inside the window were left unread. */
export interface Window {
	pulls: Merged[];
	cut: boolean;
}

export const QUERY = `query Bench($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		pullRequests(states: MERGED, first: ${MAX_MERGED}, orderBy: { field: UPDATED_AT, direction: DESC }) {
			pageInfo { hasNextPage }
			nodes {
				number url title headRefName body createdAt mergedAt updatedAt
				commits(last: 1) { nodes { commit { checkSuites(first: 20) { nodes {
					checkRuns(first: 50) { nodes { startedAt completedAt } }
				} } } } }
			}
		}
	}
}`;

/** Fetch the merged quest PRs inside the window ending at `now`. */
export async function load(github: GitHub, owner: string, name: string, now: number): Promise<Window> {
	const answer = await github.post<{ data?: { repository: unknown }; errors?: { message: string }[] }>(
		"/graphql",
		{ query: QUERY, variables: { owner, name } },
		MAX_ANSWER,
	);
	if (answer?.errors?.length) throw new Error(`GitHub's GraphQL API refused the bench: ${answer.errors[0]!.message}`);
	return window(answer?.data?.repository, now);
}

/** Read the answer, keeping quest PRs merged inside the window. */
export function window(value: unknown, now: number): Window {
	const pulls = (value as { pullRequests?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } } | null)
		?.pullRequests;
	if (!Array.isArray(pulls?.nodes)) throw new Error("GitHub's bench answer has no pull requests");
	const { nodes } = pulls;
	const hasNextPage = pulls.pageInfo?.hasNextPage;
	if (typeof hasNextPage !== "boolean") throw new Error("GitHub's bench answer has no page info");
	const since = now - WINDOW_DAYS * 86_400_000;
	const all = nodes.map((p: any): Merged => {
		if (!Number.isSafeInteger(p?.number) || !Number.isFinite(Date.parse(p.mergedAt)))
			throw new Error("a merged PR without its number or merge time");
		if (!Number.isFinite(Date.parse(p.updatedAt))) throw new Error("a merged PR without its last update time");
		const suites = p.commits?.nodes?.[0]?.commit?.checkSuites?.nodes ?? [];
		return {
			number: p.number,
			url: String(p.url),
			title: String(p.title),
			branch: String(p.headRefName),
			body: String(p.body ?? ""),
			created: String(p.createdAt),
			merged: p.mergedAt,
			checks: suites.flatMap((s: any) =>
				(s?.checkRuns?.nodes ?? []).map((r: any) => ({
					started: r?.startedAt ?? null,
					completed: r?.completedAt ?? null,
				})),
			),
		};
	});
	// A later page can contain an in-window merge only if its last update can also be inside the window.
	const cut = hasNextPage && Date.parse(nodes.at(-1)?.updatedAt) >= since;
	return {
		pulls: all
			.filter((p) => p.branch.startsWith("quest/") && Date.parse(p.merged) >= since)
			.sort((a, b) => Date.parse(b.merged) - Date.parse(a.merged)),
		cut,
	};
}
