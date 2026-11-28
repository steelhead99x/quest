// A commit's CI on GitHub: its check runs and workflow runs, and the two
// actions the site offers: re-running a failed run's failed jobs and
// dispatching a workflow. GitHub decides whether the person may; the site
// shows its answer.

import { type GitHub, Malformed } from "./client.ts";

/** Check runs and workflow runs read per page; the page says when more exist. */
export const PER_PAGE = 30;

/** One check or workflow run, as a page shows it. */
export interface Run {
	id: number;
	name: string;
	/** queued, in_progress, completed, waiting, requested, pending. */
	status: string;
	/** success, failure, cancelled, timed_out, action_required, neutral, skipped, stale, or null while running. */
	conclusion: string | null;
	url: string;
	/** Seconds from start to finish, or to now while it runs; null before it starts. */
	seconds: number | null;
	/** For a workflow run: whether the site may offer to re-run its failed jobs. */
	rerun: boolean;
	/** Why a failed run cannot be re-run here, shown in place of the button. */
	why: string | null;
	/** A check run GitHub Actions made, which its workflow run already shows. */
	actions: boolean;
}

/** A list of runs, and whether GitHub has more than one page. */
export interface Runs {
	runs: Run[];
	more: boolean;
}

/** Conclusions whose failed jobs GitHub can re-run. */
const RERUNNABLE = new Set(["failure", "cancelled", "timed_out"]);

function seconds(start: unknown, end: unknown, now: number): number | null {
	if (typeof start !== "string") return null;
	const from = Date.parse(start);
	const to = typeof end === "string" ? Date.parse(end) : now;
	return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 1000)) : null;
}

/**
 * A workflow run as the page shows it, deciding whether to offer a re-run.
 * Only a run whose head is a branch of `repository` itself qualifies: a re-run
 * keeps the original actor's privileges and ref, so a fork's run, finished or
 * waiting for approval, is re-run on GitHub, where its source is shown.
 */
export function workflowRun(r: Record<string, any>, now: number, repository: string): Run {
	if (!Number.isSafeInteger(r?.id)) throw new Malformed("GitHub listed a workflow run without an id");
	const conclusion = typeof r.conclusion === "string" ? r.conclusion : null;
	const waiting = conclusion === "action_required" || r.status === "waiting" || r.status === "action_required";
	const head = typeof r.head_repository?.full_name === "string" ? r.head_repository.full_name : null;
	const own = head !== null && head.toLowerCase() === repository.toLowerCase();
	const failed = r.status === "completed" && conclusion !== null && RERUNNABLE.has(conclusion);
	return {
		id: r.id,
		name: String(r.name ?? r.display_title ?? `run ${r.id}`),
		status: String(r.status),
		conclusion,
		url: String(r.html_url),
		seconds: seconds(r.run_started_at, r.status === "completed" ? r.updated_at : undefined, now),
		rerun: failed && !waiting && own,
		why: waiting ? "Approve it on GitHub" : failed && !own ? "From a fork: re-run it on GitHub" : null,
		actions: true,
	};
}

/** A check run as the page shows it; check runs from other apps are re-run on GitHub. */
export function checkRun(r: Record<string, any>, now: number): Run {
	if (!Number.isSafeInteger(r?.id)) throw new Malformed("GitHub listed a check run without an id");
	return {
		id: r.id,
		name: String(r.name),
		status: String(r.status),
		conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
		url: String(r.html_url ?? r.details_url),
		seconds: seconds(r.started_at, r.completed_at, now),
		rerun: false,
		why: null,
		actions: r.app?.slug === "github-actions",
	};
}

/** A commit's check runs. */
export async function checks(github: GitHub, repository: string, sha: string, now: number): Promise<Runs> {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
	const out = await github.get<{ total_count: number; check_runs: Record<string, any>[] }>(
		`/repos/${repository}/commits/${sha}/check-runs?per_page=${PER_PAGE}`,
	);
	if (!Array.isArray(out?.check_runs)) throw new Malformed("GitHub listed no check runs array");
	return { runs: out.check_runs.map((r) => checkRun(r, now)), more: out.total_count > PER_PAGE };
}

/** Workflow runs for a commit, or the newest on a branch. */
export async function runs(
	github: GitHub,
	repository: string,
	filter: { sha: string } | { branch: string },
	now: number,
	count = PER_PAGE,
): Promise<Runs> {
	const query = "sha" in filter ? `head_sha=${filter.sha}` : `branch=${encodeURIComponent(filter.branch)}`;
	const out = await github.get<{ total_count: number; workflow_runs: Record<string, any>[] }>(
		`/repos/${repository}/actions/runs?${query}&per_page=${count}`,
	);
	if (!Array.isArray(out?.workflow_runs)) throw new Malformed("GitHub listed no workflow runs array");
	return { runs: out.workflow_runs.map((r) => workflowRun(r, now, repository)), more: out.total_count > count };
}

/** Re-run a workflow run's failed jobs, after rechecking it with GitHub; returns the run. */
export async function rerunFailed(github: GitHub, repository: string, id: number, now: number): Promise<Run> {
	const run = workflowRun(await github.get(`/repos/${repository}/actions/runs/${id}`), now, repository);
	if (!run.rerun)
		throw new Refused(
			run.why === "Approve it on GitHub"
				? `${run.name} is waiting for a maintainer's approval on GitHub.`
				: run.why
					? `${run.name} ran from a fork, so it is re-run on GitHub, where its source is shown.`
					: `${run.name} is ${run.conclusion ?? run.status}, with no failed jobs to re-run.`,
		);
	await github.post(`/repos/${repository}/actions/runs/${id}/rerun-failed-jobs`, {});
	return run;
}

/** Dispatch a workflow on a branch. */
export async function dispatch(github: GitHub, repository: string, file: string, ref: string): Promise<void> {
	if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(file)) throw new Refused(`not a workflow file: ${file}`);
	await github.post(`/repos/${repository}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref });
}

/** The site will not take an action, and says why. */
export class Refused extends Error {}
