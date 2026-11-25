// A stand-in for GitHub, for the demo: the OAuth token endpoint, the REST and
// GraphQL calls the Worker makes, and re-runs and dispatches, answered from a
// snapshot of this repository's real quest tree. Claims, CI runs, and merged
// PRs are made up around it, and actions change them in memory.

import { parse, unblocked } from "../../src/core/index.ts";

/** What snapshot.ts writes. */
export interface Snapshot {
	commit: string;
	quests: { path: string; text: string }[];
	workflows: { path: string; text: string }[];
}

export const OWNER = "steelhead99x";
export const NAME = "quest";
export const REPOSITORY = `${OWNER}/${NAME}`;
const WEB = `https://github.com/${REPOSITORY}`;
const HOUR = 3_600_000;

type Run = Record<string, unknown> & { id: number; status: string; conclusion: string | null };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** GitHub's tree entries for files under `prefix`. */
function entries(files: { path: string; text: string }[], prefix: string): unknown[] {
	const dirs = new Map<string, { path: string; text: string }[]>();
	const out: unknown[] = [];
	for (const f of files) {
		const rest = f.path.slice(prefix.length);
		const [head, ...tail] = rest.split("/");
		if (tail.length === 0) out.push({ name: head, type: "blob", object: { text: f.text, isTruncated: false } });
		else dirs.set(head!, [...(dirs.get(head!) ?? []), f]);
	}
	for (const [dir, sub] of dirs)
		out.push({ name: dir, type: "tree", object: { entries: entries(sub, `${prefix}${dir}/`) } });
	return out;
}

/** A PR body with the records `quest review` and an implementer leave. */
function recordBody(size: string, writer: string, score: number, rounds: number) {
	return [
		"## Models",
		"",
		`- Size: ${size}`,
		`- Implementer: ${writer}`,
		"",
		"## Review",
		"",
		"Rewritten by `quest review` after each round.",
		"",
		"- Reviewer: Codex, gpt-6.1-sol, high effort",
		"- Session: `demo`, round 1",
		`- Score: ${score}/10, \`Demo.\``,
		`- Rounds: ${rounds}; findings 0: fixed 0, refuted 0, open 0`,
		"- Findings: none",
	].join("\n");
}

/** The stand-in GitHub, as a fetch function, with its state for one Worker isolate. */
export function github(snapshot: Snapshot, now: () => number) {
	const t0 = now();
	const iso = (ms: number) => new Date(ms).toISOString();
	const docs = snapshot.quests.map((q) => parse(q.path, q.text));
	const ready = unblocked(docs, iso(t0).slice(0, 10)).map((r) => r.path);
	// Two ready quests get claims: one handed back as a draft, one ready for review with a failing check.
	const claims = ready.slice(0, 2).map((path, i) => ({
		number: 40 + i,
		path,
		branch: path.replace(/\.md$/, ""),
		head: String(i + 1).repeat(40),
		draft: i === 0,
	}));
	const pulls = claims.map((c) => ({
		number: c.number,
		url: `${WEB}/pull/${c.number}`,
		title: `Demo claim of ${c.path}`,
		isDraft: c.draft,
		headRefName: c.branch,
		headRefOid: c.head,
		createdAt: iso(t0 - 26 * HOUR),
		body: c.draft ? "Work so far.\n\n## Waiting\n\n- Maintainer: pick a name for the new flag\n" : "Ready.",
		author: { login: OWNER },
	}));
	let nextRun = 900;
	const run = (name: string, head: string, branch: string, conclusion: string | null, minutes: number): Run => ({
		id: nextRun++,
		name,
		head_sha: head,
		head_branch: branch,
		status: conclusion === null ? "in_progress" : "completed",
		conclusion,
		html_url: `${WEB}/actions/runs/${nextRun - 1}`,
		run_started_at: iso(t0 - minutes * 60_000 - HOUR),
		updated_at: iso(t0 - HOUR),
	});
	const review = claims[1];
	const runs: Run[] = [
		run("Check", snapshot.commit, "main", "success", 7),
		run("Gate (macOS)", snapshot.commit, "main", "success", 4),
		...(review
			? [
					run("Check", review.head, review.branch, "failure", 6),
					run("Lifecycle", review.head, review.branch, "success", 3),
					run("Windows", review.head, review.branch, "action_required", 0),
				]
			: []),
	];
	const merged = [
		["XS", "Claude Code, claude-sonnet-5-5, high effort", 10, 1, 3],
		["S", "Claude Code, claude-opus-5-5, medium effort", 9, 2, 9],
		["M", "Claude Code, claude-opus-5-5, medium effort", 9, 2, 20],
		["M", "Codex, gpt-6.1-sol, high effort", 8, 3, 30],
		["L", "Claude Code, claude-opus-5-5, high effort", 9, 4, 50],
	].map(([size, writer, score, rounds, hours], i) => ({
		number: 30 + i,
		url: `${WEB}/pull/${30 + i}`,
		title: `Demo merged ${size} quest`,
		headRefName: `quest/m0/demo-${i}`,
		body: recordBody(String(size), String(writer), Number(score), Number(rounds)),
		createdAt: iso(t0 - (Number(hours) + 24 * (i + 1)) * HOUR),
		mergedAt: iso(t0 - 24 * (i + 1) * HOUR),
		updatedAt: iso(t0 - 24 * (i + 1) * HOUR),
		commits: {
			nodes: [
				{
					commit: {
						checkSuites: {
							nodes: [
								{
									checkRuns: {
										nodes: [
											{
												startedAt: iso(t0 - 24 * (i + 1) * HOUR - 20 * 60_000),
												completedAt: iso(t0 - 24 * (i + 1) * HOUR - (12 - i) * 60_000),
											},
										],
									},
								},
							],
						},
					},
				},
			],
		},
	}));

	const repository = () => ({
		nameWithOwner: REPOSITORY,
		url: WEB,
		isPrivate: false,
		defaultBranchRef: { name: "main", target: { oid: snapshot.commit, committedDate: iso(t0 - 2 * HOUR) } },
		object: { entries: entries(snapshot.quests, "quest/") },
		workflows: { entries: entries(snapshot.workflows, ".github/workflows/") },
		pullRequests: { totalCount: pulls.length, nodes: pulls },
		refs: { totalCount: claims.length, nodes: claims.map((c) => ({ name: c.branch.slice("quest/".length) })) },
	});

	const fetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const route = `${request.method} ${url.origin}${url.pathname}`;
		const repo = `https://api.github.com/repos/${REPOSITORY}`;
		if (route === "POST https://github.com/login/oauth/access_token")
			return json({
				access_token: `ghu_demo_${crypto.randomUUID()}`,
				expires_in: 28_800,
				refresh_token: `ghr_demo_${crypto.randomUUID()}`,
				refresh_token_expires_in: 15_897_600,
				token_type: "bearer",
			});
		if (route === "GET https://api.github.com/user") return json({ id: 1, login: "demo" });
		if (route === "GET https://api.github.com/user/installations")
			return json({ total_count: 1, installations: [{ id: 1, account: { login: OWNER } }] });
		if (route === "GET https://api.github.com/user/installations/1/repositories")
			return json({ total_count: 1, repositories: [{ name: NAME, private: false, owner: { login: OWNER } }] });
		if (route === "POST https://api.github.com/graphql") {
			const { query } = (await request.json()) as { query: string };
			if (query.includes("query Board")) return json({ data: { repository: repository() } });
			if (query.includes("query Bench"))
				return json({ data: { repository: { pullRequests: { nodes: merged, pageInfo: { hasNextPage: false } } } } });
			return json({ errors: [{ message: "the demo answers only the board and bench queries" }] });
		}
		const checks = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/check-runs$/.exec(url.pathname);
		if (request.method === "GET" && checks)
			return json({
				total_count: runs.filter((r) => r.head_sha === checks[1]).length,
				check_runs: runs
					.filter((r) => r.head_sha === checks[1])
					.map((r) => ({
						id: r.id + 10_000,
						app: { slug: "github-actions" },
						name: r.name,
						status: r.status,
						conclusion: r.conclusion,
						html_url: r.html_url,
						started_at: r.run_started_at,
						completed_at: r.status === "completed" ? r.updated_at : null,
					})),
			});
		if (route === `GET ${repo}/actions/runs`) {
			const sha = url.searchParams.get("head_sha");
			const branch = url.searchParams.get("branch");
			const found = runs.filter((r) => (sha ? r.head_sha === sha : r.head_branch === branch)).reverse();
			return json({ total_count: found.length, workflow_runs: found });
		}
		const one = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(\/rerun-failed-jobs)?$/.exec(url.pathname);
		if (one) {
			const found = runs.find((r) => r.id === Number(one[1]));
			if (!found) return json({ message: "Not Found" }, 404);
			if (request.method === "GET" && !one[2]) return json(found);
			if (request.method === "POST" && one[2]) {
				Object.assign(found, { status: "in_progress", conclusion: null, run_started_at: iso(now()) });
				return json({}, 201);
			}
		}
		const dispatched = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url.pathname);
		if (request.method === "POST" && dispatched) {
			const file = decodeURIComponent(dispatched[1]!);
			const workflow = snapshot.workflows.find((w) => w.path.endsWith(`/${file}`));
			if (!workflow) return json({ message: "Not Found" }, 404);
			const ref = ((await request.json()) as { ref: string }).ref;
			const name = /^name:\s*(.+)$/m.exec(workflow.text)?.[1] ?? file;
			runs.push({ ...run(name, snapshot.commit, ref, null, 0), status: "queued", event: "workflow_dispatch" });
			return new Response(null, { status: 204 });
		}
		if (request.method === "DELETE" && /^\/applications\/[^/]+\/token$/.test(url.pathname))
			return new Response(null, { status: 204 });
		return json({ message: `the demo has no ${request.method} ${url.pathname}` }, 404);
	};

	return { fetch, claims, runs };
}
