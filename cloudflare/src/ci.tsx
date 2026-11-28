import type { Workflow } from "./board/load.ts";
import type { Run, Runs } from "./github/ci.ts";
import { Entry, Heading } from "./layout.tsx";

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
	const tone = run.status === "completed" ? TONE[run.conclusion ?? ""] : "ql-running";
	return (
		<Entry title={run.name} href={run.url} tone={tone}>
			<span class={`ci-state ${tone ?? ""}`}>{state(run)}</span>
			{run.seconds !== null && run.seconds > 0 && <span class="muted">{took(run.seconds)}</span>}
			{run.why && <a href={run.url}>{run.why}</a>}
			{run.rerun && (
				<form method="post" action={`/repos/${props.repository}/runs/${run.id}/rerun`}>
					<input type="hidden" name="next" value={props.next} />
					<button class="button small">Re-run failed jobs</button>
				</form>
			)}
		</Entry>
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
	/** Why the runs couldn't be read, shown in place of them. */
	error?: string;
}) {
	return (
		<section class="block ci">
			<Heading title={props.title} />
			{props.error ? (
				<p class="muted">
					{props.error} <a href={props.link}>See the runs on GitHub</a>
				</p>
			) : (
				props.runs.length === 0 && <p class="muted">No runs yet.</p>
			)}
			{!props.error && (
				<ul class="log">
					{props.runs.map((run) => (
						<RunRow run={run} repository={props.repository} next={props.next} />
					))}
				</ul>
			)}
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

/** A PR's CI that this site cannot read, such as an upstream PR where the App is not installed. */
export function CiElsewhere(props: { repository: string; link: string }) {
	return (
		<section class="block ci">
			<Heading title="CI" />
			<p class="muted">
				This site can't read {props.repository}'s CI. <a href={props.link}>See the checks on GitHub</a>
			</p>
		</section>
	);
}

/** The workflows a signed-in person can start on the default branch, folded away. */
export function Dispatch(props: { workflows: Workflow[]; repository: string; branch: string; next: string }) {
	const startable = props.workflows.filter((w) => w.dispatch);
	if (startable.length === 0) return null;
	return (
		<details class="fold ci">
			<summary>
				<span class="fold-title">
					Run a workflow on <code class="ident">{props.branch}</code>
				</span>
				<span class="count">{startable.length}</span>
			</summary>
			<ul class="log">
				{startable.map((w) => (
					<Entry title={w.name}>
						{w.inputs ? (
							<a
								href={`https://github.com/${props.repository}/actions/workflows/${encodeURIComponent(w.file)}`}
							>
								Needs inputs: run on GitHub
							</a>
						) : (
							<form method="post" action={`/repos/${props.repository}/workflows/${w.file}/dispatch`}>
								<input type="hidden" name="next" value={props.next} />
								<button class="button small">Run</button>
							</form>
						)}
					</Entry>
				))}
			</ul>
		</details>
	);
}
