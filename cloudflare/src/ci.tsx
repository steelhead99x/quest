import type { Workflow } from "./board/load.ts";
import type { Run, Runs } from "./github/ci.ts";

const WORDS: Record<string, string> = {
	success: "Passed",
	failure: "Failed",
	cancelled: "Cancelled",
	timed_out: "Timed out",
	action_required: "Needs approval",
	skipped: "Skipped",
	neutral: "Neutral",
	stale: "Stale",
	in_progress: "Running",
	queued: "Queued",
	waiting: "Waiting",
	requested: "Queued",
	pending: "Queued",
};

/** A run's state in plain words. */
export function state(run: Run): string {
	const key = run.status === "completed" ? (run.conclusion ?? "neutral") : run.status;
	return WORDS[key] ?? key.replace(/_/g, " ");
}

/** How long a run took, such as `3m 05s`. */
export function took(seconds: number | null): string {
	if (seconds === null) return "";
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

const TONE: Record<string, string> = {
	success: "ql-s",
	failure: "ql-xl",
	timed_out: "ql-xl",
	cancelled: "ql-xs",
	action_required: "ql-available",
};

function RunRow(props: { run: Run; repository: string; next: string }) {
	const { run } = props;
	return (
		<li class="entry plain ci-run">
			<a class="entry-title" href={run.url}>
				{run.name}
			</a>
			<span class="entry-meta">
				<span class={`ci-state ${TONE[run.conclusion ?? ""] ?? ""}`}>{state(run)}</span>
				{run.seconds !== null && run.seconds > 0 && <span class="muted">{took(run.seconds)}</span>}
				{run.why && <a href={run.url}>{run.why}</a>}
				{run.rerun && (
					<form method="post" action={`/repos/${props.repository}/runs/${run.id}/rerun`}>
						<input type="hidden" name="next" value={props.next} />
						<button class="button quiet">Re-run failed jobs</button>
					</form>
				)}
			</span>
		</li>
	);
}

/** A list of runs under a heading, with a link to GitHub when it has more. */
export function RunList(props: {
	title: string;
	runs: Run[];
	more: boolean;
	repository: string;
	next: string;
	link: string;
}) {
	return (
		<section class="ql-panel ci">
			<h2>{props.title}</h2>
			{props.runs.length === 0 && <p class="muted">No runs yet.</p>}
			<ul class="log">
				{props.runs.map((run) => (
					<RunRow run={run} repository={props.repository} next={props.next} />
				))}
			</ul>
			{props.more && (
				<p>
					<a href={props.link}>All runs on GitHub</a>
				</p>
			)}
		</section>
	);
}

/** A PR's CI: its workflow runs, then any checks from apps other than Actions. */
export function PullCi(props: { runs: Runs; checks: Runs; repository: string; next: string; link: string }) {
	const others = props.checks.runs.filter((r) => !r.actions);
	return (
		<RunList
			title="CI"
			runs={[...props.runs.runs, ...others]}
			more={props.runs.more || props.checks.more}
			repository={props.repository}
			next={props.next}
			link={props.link}
		/>
	);
}

/** The workflows a signed-in person can start on the default branch, folded away. */
export function Dispatch(props: { workflows: Workflow[]; repository: string; branch: string; next: string }) {
	const startable = props.workflows.filter((w) => w.dispatch);
	if (startable.length === 0) return null;
	return (
		<details class="ql-panel ci">
			<summary>Run a workflow on {props.branch}</summary>
			<ul class="log">
				{startable.map((w) => (
					<li class="entry plain">
						<span class="entry-title">{w.name}</span>
						<span class="entry-meta">
							<form method="post" action={`/repos/${props.repository}/workflows/${w.file}/dispatch`}>
								<input type="hidden" name="next" value={props.next} />
								<button class="button quiet">Run</button>
							</form>
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}
