import type { Workflow } from "./board/load.ts";
import type { Run, Runs } from "./github/ci.ts";

/** A run's state as a word, colour-coded but never by colour alone. */
export function state(run: Run): string {
	if (run.status !== "completed") return run.status.replace(/_/g, " ");
	return (run.conclusion ?? "done").replace(/_/g, " ");
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
		<li class="entry ci-run">
			<span class="ql-marker" />
			<a class="entry-title" href={run.url}>
				{run.name}
			</a>
			<span class="entry-meta">
				<span class={`ci-state ${TONE[run.conclusion ?? ""] ?? ""}`}>{state(run)}</span>
				{run.seconds !== null && <span class="muted">{took(run.seconds)}</span>}
				{run.rerun && (
					<form method="post" action={`/repos/${props.repository}/runs/${run.id}/rerun`}>
						<input type="hidden" name="next" value={props.next} />
						<button class="button quiet">Re-run failed jobs</button>
					</form>
				)}
				{run.why && <span class="muted">{run.why}</span>}
			</span>
		</li>
	);
}

/** A list of runs under a heading, saying when GitHub has more. */
export function RunList(props: { title: string; runs: Runs; repository: string; next: string; more: string }) {
	return (
		<section class="ql-panel ci">
			<h2>{props.title}</h2>
			{props.runs.runs.length === 0 && <p class="muted">None yet.</p>}
			<ul class="log">
				{props.runs.runs.map((run) => (
					<RunRow run={run} repository={props.repository} next={props.next} />
				))}
			</ul>
			{props.runs.more && (
				<p class="muted">
					More on <a href={props.more}>GitHub</a>.
				</p>
			)}
		</section>
	);
}

/** The workflows a signed-in person can start on the default branch. */
export function Dispatch(props: { workflows: Workflow[]; repository: string; branch: string; next: string }) {
	const startable = props.workflows.filter((w) => w.dispatch);
	if (startable.length === 0) return null;
	return (
		<section class="ql-panel ci">
			<h2>Start a workflow</h2>
			<p class="muted">
				Runs it on {props.branch}. GitHub checks that you can, and workflows with required inputs start on
				GitHub.
			</p>
			<ul class="log">
				{startable.map((w) => (
					<li class="entry">
						<span class="ql-marker" />
						<span class="entry-title">{w.name}</span>
						<span class="entry-meta">
							<span class="muted">{w.file}</span>
							<form method="post" action={`/repos/${props.repository}/workflows/${w.file}/dispatch`}>
								<input type="hidden" name="next" value={props.next} />
								<button class="button quiet">Run</button>
							</form>
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
