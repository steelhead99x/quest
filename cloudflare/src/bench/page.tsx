import { boardHref } from "../board/pages.tsx";
import { Difficulty, Layout, type Size, type User } from "../layout.tsx";
import { WINDOW_DAYS } from "./load.ts";
import type { Rollup, Row } from "./model.ts";

const SIZES = ["XS", "S", "M", "L", "XL"];
const num = (v: number | null, digits = 1) => (v === null ? "n/a" : v.toFixed(digits));

function SizeLabel(props: { size: string | null }) {
	return props.size && SIZES.includes(props.size) ? (
		<Difficulty size={props.size as Size} />
	) : (
		<span class="muted">{props.size ?? "unsized"}</span>
	);
}

function Rollups(props: { title: string; label: string; rows: Rollup[]; sized?: boolean }) {
	return (
		<section class="ql-panel">
			<h2>{props.title}</h2>
			<div class="stats-scroll">
				<table class="stats-table">
					<caption class="muted">Medians over merged quest PRs</caption>
					<thead>
						<tr>
							<th scope="col">{props.label}</th>
							<th scope="col">PRs</th>
							<th scope="col">Review score</th>
							<th scope="col">Rounds</th>
							<th scope="col">Claim to merge (h)</th>
							<th scope="col">CI (min)</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((r) => (
							<tr>
								<th scope="row">{props.sized ? <SizeLabel size={r.key} /> : <code>{r.key}</code>}</th>
								<td>{r.pulls}</td>
								<td>{num(r.score)}</td>
								<td>{num(r.rounds)}</td>
								<td>{num(r.hours)}</td>
								<td>{num(r.ci)}</td>
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
			title={`Bench · ${repository}`}
			description={`How ${repository}'s quests performed.`}
			path={props.path}
			user={props.user}
			crumbs={[
				{ label: "Repositories", href: "/" },
				{ label: repository, href: boardHref(repository) },
				{ label: "Bench", href: `${boardHref(repository)}/bench` },
			]}
		>
			<section class="wrap board">
				<header class="board-head">
					<p class="ql-eyebrow">Bench</p>
					<h1>{repository}</h1>
					<p class="muted">
						Quest PRs merged in the last {WINDOW_DAYS} days, from each PR's <code>## Models</code> and{" "}
						<code>## Review</code> records and its head commit's checks. Token cost is not shown: it stays
						in each host's transcripts. <code>quest eval run</code> scores are not shown either: nothing
						records them where this page can read them.
					</p>
					{props.cut && (
						<p class="muted" role="status">
							Only the 50 most recently updated merged PRs were read. The totals may omit other merges in this
							window.
						</p>
					)}
				</header>
				{props.rows.length === 0 && <p>No quest PRs merged in the last {WINDOW_DAYS} days.</p>}
				{props.rows.length > 0 && (
					<>
						<Rollups title="By size" label="Size" rows={props.sizes} sized />
						<Rollups title="By writer" label="Model" rows={props.writers} />
						<section class="ql-panel">
							<h2>Merged quests</h2>
							<ul class="log">
								{props.rows.map((r) => (
									<li class="entry">
										<span class="ql-marker" />
										<a class="entry-title" href={r.url}>
											#{r.number} {r.title}
										</a>
										<span class="entry-meta">
											<SizeLabel size={r.size} />
											{r.models[0] && <code>{r.models[0]}</code>}
											<span>score {num(r.score)}</span>
											<span>{num(r.rounds, 0)} rounds</span>
											<span>{num(r.hours)} h</span>
											<span>CI {num(r.ci)} min</span>
											{r.unreadable && (
												<span class="muted">Review record unreadable: {r.unreadable}</span>
											)}
										</span>
									</li>
								))}
							</ul>
						</section>
					</>
				)}
			</section>
		</Layout>
	);
}
