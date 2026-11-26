import { boardHref, RepoHeading } from "../board/pages.tsx";
import { Difficulty, Entry, Heading, Layout, type Size, type User } from "../layout.tsx";
import { WINDOW_DAYS } from "./load.ts";
import type { Rollup, Row } from "./model.ts";

const SIZES = ["XS", "S", "M", "L", "XL"];
const num = (v: number | null, digits = 1) => (v === null ? "–" : v.toFixed(digits));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function SizeLabel(props: { size: string | null }) {
	return props.size && SIZES.includes(props.size) ? (
		<Difficulty size={props.size as Size} />
	) : (
		<span class="muted">{props.size ?? "unsized"}</span>
	);
}

function Rollups(props: { title: string; label: string; rows: Rollup[]; sized?: boolean }) {
	return (
		<section class="block">
			<Heading title={props.title} />
			<div class="stats-scroll">
				<table class="stats-table cards">
					<thead>
						<tr>
							<th scope="col">{props.label}</th>
							<th scope="col">PRs</th>
							<th scope="col">Score</th>
							<th scope="col">Rounds</th>
							<th scope="col">To merge</th>
							<th scope="col">CI</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((r) => (
							<tr>
								<th scope="row">{props.sized ? <SizeLabel size={r.key} /> : r.key}</th>
								<td data-label="PRs">{r.pulls}</td>
								<td data-label="Score">{num(r.score)}</td>
								<td data-label="Rounds">{num(r.rounds)}</td>
								<td data-label="To merge">{r.hours === null ? "–" : `${num(r.hours)}h`}</td>
								<td data-label="CI">{r.ci === null ? "–" : `${num(r.ci)}m`}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

/** How a repository's quests performed over the window. */
export function BenchPage(props: {
	repository: string;
	user: User;
	path: string;
	rows: Row[];
	sizes: Rollup[];
	writers: Rollup[];
	cut: boolean;
}) {
	const { repository } = props;
	return (
		<Layout
			title={`How quests merged in ${repository}`}
			description={`How ${repository}'s quests performed.`}
			path={props.path}
			user={props.user}
			crumbs={[
				{ label: repository, href: boardHref(repository) },
				{ label: "How quests merged", href: `${boardHref(repository)}/bench` },
			]}
		>
			<section class="wrap board">
				<RepoHeading repository={repository}>
					<p class="as-of muted">
						Quests merged in the last {WINDOW_DAYS} days. Medians; score out of 10, review rounds, hours
						from claim to merge, and minutes of CI.
					</p>
					{props.cut && (
						<p class="muted" role="status">
							Only the 50 most recently updated merged PRs were read, so totals may miss some merges.
						</p>
					)}
				</RepoHeading>
				{props.rows.length === 0 && <p>No quests merged in the last {WINDOW_DAYS} days.</p>}
				{props.rows.length > 0 && (
					<>
						<Rollups title="By size" label="Size" rows={props.sizes} sized />
						<Rollups title="By writer" label="Model" rows={props.writers} />
						<section class="block">
							<Heading title="Merged" count={props.rows.length} />
							<ul class="log">
								{props.rows.map((r) => (
									<Entry
										title={
											<>
												{r.title} <span class="muted">#{r.number}</span>
											</>
										}
										href={r.url}
										size={r.size && SIZES.includes(r.size) ? (r.size as Size) : null}
									>
										<SizeLabel size={r.size} />
										{r.models[0] && <span class="muted">{r.models[0]}</span>}
										{r.score !== null && <span>{r.score}/10</span>}
										{r.rounds !== null && <span>{plural(r.rounds, "round")}</span>}
										<span>{num(r.hours)}h to merge</span>
										{r.ci !== null && <span>{num(r.ci)}m CI</span>}
										{r.unreadable && (
											<span class="muted">Review record unreadable: {r.unreadable}</span>
										)}
									</Entry>
								))}
							</ul>
						</section>
					</>
				)}
			</section>
		</Layout>
	);
}
