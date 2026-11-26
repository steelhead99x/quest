import { raw } from "hono/html";
import { questBranch, renderBlocker } from "../../../src/core/index.ts";
import { type Crumb, Difficulty, Layout, Marker, type Size, type Status, type User } from "../layout.tsx";
import { render } from "./markdown.ts";
import { type Board, type Counts, holdsBack, name, parents, type Quest } from "./model.ts";

/** Each state's label, as design/theme.md pairs it with its marker. */
export const LABELS: Record<Status, string> = {
	ready: "Ready",
	blocked: "Blocked",
	claimed: "Claimed",
	review: "In review",
};

const ORDER: Status[] = ["ready", "review", "claimed", "blocked"];

/** A board's address. */
export function boardHref(repository: string): string {
	return `/repos/${repository}`;
}

/** A quest's page: the board's address plus its branch, as `quest start` names it. */
export function questHref(repository: string, path: string): string {
	return `${boardHref(repository)}/${questBranch(path).split("/").map(encodeURIComponent).join("/")}`;
}

function blob(b: Board, path: string, fragment = ""): string {
	return `${b.tree.url}/blob/${b.tree.commit}/${path.split("/").map(encodeURIComponent).join("/")}${fragment}`;
}

function State(props: { status: Status; quest?: Quest }) {
	const q = props.quest;
	const text = q?.handedBack ? "Handed back" : LABELS[props.status];
	return (
		<span class={`entry-status ql-${props.status}`}>
			{text}
			{q?.pull && (
				<>
					{" "}
					· <a href={q.pull.url}>#{q.pull.number}</a>
				</>
			)}
		</span>
	);
}

function Row(props: { b: Board; quest: Quest; note?: string }) {
	const { quest } = props;
	return (
		<li class="entry">
			<Marker status={quest.status} />
			<a class="entry-title" href={questHref(props.b.tree.repository, quest.path)}>
				{quest.title}
			</a>
			<span class="entry-meta">
				{quest.size && <Difficulty size={quest.size} />}
				<State status={quest.status} quest={quest} />
				{props.note && <span class="muted">{props.note}</span>}
			</span>
		</li>
	);
}

function Tally(props: { counts: Counts }) {
	return (
		<ul class="tally" aria-label="Quests by state">
			{ORDER.map((s) => (
				<li>
					<span class="tally-item">
						<Marker status={s} />
						{LABELS[s]} <strong>{props.counts[s]}</strong>
					</span>
				</li>
			))}
		</ul>
	);
}

function Stats(props: { b: Board }) {
	const { b } = props;
	const sizes = (["XS", "S", "M", "L", "XL"] as Size[]).filter((s) => b.sizes[s] > 0);
	return (
		<section class="ql-panel stats">
			<h2>Stats</h2>
			<Tally counts={b.counts} />
			<div class="stats-scroll">
				<table class="stats-table">
					<caption class="muted">Open quests by milestone and state</caption>
					<thead>
						<tr>
							<th scope="col">Milestone</th>
							{ORDER.map((s) => (
								<th scope="col">{LABELS[s]}</th>
							))}
							<th scope="col">Total</th>
						</tr>
					</thead>
					<tbody>
						{b.milestones.map((m) => (
							<tr>
								<th scope="row">
									<a href={questHref(b.tree.repository, m.path)}>{m.path.split("/")[1]}</a>{" "}
									<span class="muted">{m.title}</span>
								</th>
								{ORDER.map((s) => (
									<td>{m.counts[s]}</td>
								))}
								<td>{m.total}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p class="size-tally" aria-label="Open quests by size">
				{sizes.map((s) => (
					<span>
						<Difficulty size={s} /> {b.sizes[s]}
					</span>
				))}
				{b.sizes.unsized > 0 && <span class="muted">Unsized {b.sizes.unsized}</span>}
			</p>
		</section>
	);
}

/** A repository's board: stats, ready quests, what waits on the maintainer, and every milestone. */
export function BoardPage(props: { b: Board; user: User; path: string; children?: unknown }) {
	const { b } = props;
	const repository = b.tree.repository;
	const quests = [...b.quests.values()];
	return (
		<Layout
			title={repository}
			description={`The quest log for ${repository}.`}
			path={props.path}
			user={props.user}
			crumbs={[
				{ label: "Repositories", href: "/" },
				{ label: repository, href: boardHref(repository) },
			]}
		>
			<section class="wrap board">
				<header class="board-head">
					<p class="ql-eyebrow">Quest log</p>
					<h1>{repository}</h1>
					<p class="as-of muted">
						{b.tree.branch} at{" "}
						<a href={`${b.tree.url}/commit/${b.tree.commit}`}>{b.tree.commit.slice(0, 7)}</a>
						{b.tree.committed && `, ${b.tree.committed.slice(0, 10)}`} ·{" "}
						<a href={`${boardHref(repository)}/bench`}>Bench</a>
					</p>
				</header>
				{b.tree.documents.length === 0 && <p>This repository has no quest tree on {b.tree.branch}.</p>}
				{b.findings.length > 0 && (
					<section class="ql-panel note" role="alert">
						<h2>The quest tree is invalid</h2>
						<p>
							<code>quest check</code> would report these, so nothing is ranked until they are fixed:
						</p>
						<ul>
							{b.findings.slice(0, 20).map((f) => (
								<li>
									<code>{f}</code>
								</li>
							))}
						</ul>
					</section>
				)}
				{b.tree.gaps.length > 0 && (
					<ul class="muted">
						{b.tree.gaps.map((g) => (
							<li>{g}</li>
						))}
					</ul>
				)}
				{quests.length > 0 && <Stats b={b} />}
				{props.children}
				{b.ranked.length > 0 && (
					<section class="ql-panel">
						<h2>Ready to start</h2>
						<p class="muted">
							In <code>quest unblocked</code> order: milestone, then how much each unblocks.
						</p>
						<ol class="log">
							{b.ranked.slice(0, 15).map((r) => (
								<Row
									b={b}
									quest={r.quest}
									note={r.dependents ? `unblocks ${r.dependents}` : undefined}
								/>
							))}
						</ol>
						{b.ranked.length > 15 && <p class="muted">And {b.ranked.length - 15} more below.</p>}
					</section>
				)}
				{b.waiting.length > 0 && (
					<section class="ql-panel">
						<h2>Waiting</h2>
						<ul class="log">
							{b.waiting.slice(0, 20).map((w) => (
								<li class="entry">
									<span class="ql-marker" />
									{w.path ? (
										<a class="entry-title" href={questHref(repository, w.path)}>
											{b.quests.get(w.path)?.title ??
												name(b.docs.find((d) => d.path === w.path)!)}
										</a>
									) : (
										<a class="entry-title" href={w.pr!}>
											{w.pr}
										</a>
									)}
									<span class="entry-meta">
										{w.waits.map((x) => (
											<span>
												<strong>{x.party}:</strong> {x.text.slice(0, 240)}
												{x.text.length > 240 && "…"}
											</span>
										))}
									</span>
								</li>
							))}
						</ul>
					</section>
				)}
				{b.milestones.map((m) => (
					<section class="ql-panel milestone" id={m.path.split("/")[1]}>
						<p class="ql-eyebrow">{m.path.split("/")[1]}</p>
						<h2>
							<a href={questHref(repository, m.path)}>{m.title}</a>
						</h2>
						<ul class="log">
							{quests
								.filter((q) => q.path.startsWith(m.path.replace(/README\.md$/, "")))
								.map((q) => (
									<Row b={b} quest={q} />
								))}
						</ul>
					</section>
				))}
			</section>
		</Layout>
	);
}

/** One quest's page: its status, claim, blockers, and rendered Markdown. */
export function QuestPage(props: { b: Board; path: string; doc: string; user: User; now: number; children?: unknown }) {
	const { b } = props;
	const repository = b.tree.repository;
	const doc = b.docs.find((d) => d.path === props.doc)!;
	const quest = b.quests.get(doc.path);
	const content = b.tree.documents.find((d) => d.path === doc.path)!.content;
	const sections = render(
		{
			quest: (path) => (b.docs.some((d) => d.path === path) ? questHref(repository, path) : null),
			blob: (path, fragment) => blob(b, path, fragment),
		},
		doc.path,
		content,
	);
	const crumbs: Crumb[] = [
		{ label: "Repositories", href: "/" },
		{ label: repository, href: boardHref(repository) },
		...parents(b, doc.path).map((p) => ({ label: name(p), href: questHref(repository, p.path) })),
		{ label: name(doc), href: questHref(repository, doc.path) },
	];
	const blocked = quest?.status === "blocked" ? holdsBack(b, doc.path, props.now) : [];
	return (
		<Layout
			title={name(doc)}
			description={`${name(doc)}, a quest in ${repository}.`}
			path={props.path}
			user={props.user}
			crumbs={crumbs}
		>
			<article class="wrap quest-view">
				<header class="quest-title">
					{quest && <Marker status={quest.status} />}
					<h1>{name(doc)}</h1>
				</header>
				<p class="quest-meta">
					{quest?.size && <Difficulty size={quest.size} />}
					{quest && <State status={quest.status} quest={quest} />}
					{!quest && <span class="muted">Epic</span>}
					<a href={blob(b, doc.path)}>View on GitHub</a>
				</p>
				{quest?.pull && (
					<p>
						Claimed by <a href={quest.pull.url}>{quest.pull.title}</a> from {quest.pull.author}
						{quest.pull.draft ? ", a draft" : ", ready for review"}.
					</p>
				)}
				{quest?.status === "claimed" && !quest.pull && <p>Claimed by its branch, with no PR open yet.</p>}
				{blocked.length > 0 && (
					<section class="ql-panel">
						<h2>Blocked by</h2>
						<pre>{blocked.flatMap((x) => renderBlocker(x)).join("\n")}</pre>
					</section>
				)}
				{props.children}
				<div class="quest-page">
					{sections.map((s) => (
						<section>
							{s.heading && <h2>{s.heading}</h2>}
							{raw(s.html)}
						</section>
					))}
				</div>
			</article>
		</Layout>
	);
}
