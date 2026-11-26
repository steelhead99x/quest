import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { type Blocker, questBranch } from "../../../src/core/index.ts";
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
const READY_SHOWN = 10;
const WAITING_SHOWN = 10;

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

/** The first `max` characters of `text`, cut at a word. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}

function State(props: { quest: Quest }) {
	const q = props.quest;
	return <span class={`entry-status ql-${q.status}`}>{q.handedBack ? "Handed back" : LABELS[q.status]}</span>;
}

/** A quest row. `state` shows its state label, which a list of one state leaves out. */
function Row(props: { b: Board; quest: Quest; state?: boolean; note?: string }) {
	const { quest } = props;
	return (
		<li class="entry">
			<Marker status={quest.status} />
			<a class="entry-title" href={questHref(props.b.tree.repository, quest.path)}>
				{quest.title}
			</a>
			<span class="entry-meta">
				{quest.size && <Difficulty size={quest.size} />}
				{props.state !== false && <State quest={quest} />}
				{quest.pull && <a href={quest.pull.url}>#{quest.pull.number}</a>}
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

function Milestones(props: { b: Board }) {
	const { b } = props;
	return (
		<div class="stats-scroll">
			<table class="stats-table">
				<thead>
					<tr>
						<th scope="col">Milestone</th>
						{ORDER.map((s) => (
							<th scope="col">{LABELS[s]}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{b.milestones.map((m) => (
						<tr>
							<th scope="row">
								<a href={`#${m.path.split("/")[1]}`}>{m.path.split("/")[1]}</a>{" "}
								<span class="muted">{m.title}</span>
							</th>
							{ORDER.map((s) => (
								<td>{m.counts[s]}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Sizes(props: { b: Board }) {
	const sizes = (["XS", "S", "M", "L", "XL"] as Size[]).filter((s) => props.b.sizes[s] > 0);
	return (
		<p class="size-tally" aria-label="Open quests by size">
			{sizes.map((s) => (
				<span>
					<Difficulty size={s} /> {props.b.sizes[s]}
				</span>
			))}
			{props.b.sizes.unsized > 0 && <span class="muted">Unsized {props.b.sizes.unsized}</span>}
		</p>
	);
}

/** The repository's name as a page heading: the owner small above the name. */
export function RepoHeading(props: { repository: string; children?: Child }) {
	const [owner, name] = props.repository.split("/");
	return (
		<header class="board-head">
			<p class="owner muted">{owner} /</p>
			<h1>{name}</h1>
			{props.children}
		</header>
	);
}

/** A repository's board; its children are the default branch's CI. */
export function BoardPage(props: { b: Board; user: User; path: string; children?: Child }) {
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
				<RepoHeading repository={repository}>
					<p class="as-of muted">
						{b.tree.branch}{" "}
						<a href={`${b.tree.url}/commit/${b.tree.commit}`}>{b.tree.commit.slice(0, 7)}</a> ·{" "}
						<a href={`${boardHref(repository)}/bench`}>Bench</a>
					</p>
				</RepoHeading>
				{b.tree.documents.length === 0 && <p>No quest tree on {b.tree.branch}.</p>}
				{b.findings.length > 0 && (
					<section class="ql-panel note" role="alert">
						<h2>Invalid quest tree</h2>
						<p>Nothing is ranked until these are fixed:</p>
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
					<ul class="muted gaps">
						{b.tree.gaps.map((g) => (
							<li>{g}</li>
						))}
					</ul>
				)}
				{quests.length > 0 && (
					<section class="summary">
						<Tally counts={b.counts} />
						<Milestones b={b} />
						<Sizes b={b} />
					</section>
				)}
				{b.ranked.length > 0 && (
					<section class="ql-panel">
						<h2>Ready to start</h2>
						<ol class="log">
							{b.ranked.slice(0, READY_SHOWN).map((r) => (
								<Row
									b={b}
									quest={r.quest}
									state={false}
									note={r.dependents ? `unblocks ${r.dependents}` : undefined}
								/>
							))}
						</ol>
						{b.ranked.length > READY_SHOWN && (
							<p class="muted">{b.ranked.length - READY_SHOWN} more under their milestones.</p>
						)}
					</section>
				)}
				{b.waiting.length > 0 && (
					<section class="ql-panel">
						<h2>Waiting</h2>
						<ul class="log">
							{b.waiting.slice(0, WAITING_SHOWN).map((w) => (
								<li class="entry plain">
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
									<span class="entry-why">
										<strong>{w.waits[0]!.party}:</strong> {clip(w.waits[0]!.text, 100)}
										{w.waits.length > 1 && ` (and ${w.waits.length - 1} more)`}
									</span>
								</li>
							))}
						</ul>
						{b.waiting.length > WAITING_SHOWN && (
							<p class="muted">{b.waiting.length - WAITING_SHOWN} more.</p>
						)}
					</section>
				)}
				{props.children}
				{b.milestones.map((m) => {
					const mine = quests.filter((q) => q.path.startsWith(m.path.replace(/README\.md$/, "")));
					return (
						<details class="ql-panel milestone" id={m.path.split("/")[1]}>
							<summary>
								<span class="ql-eyebrow">{m.path.split("/")[1]}</span> {m.title}{" "}
								<span class="muted">{mine.length}</span>
							</summary>
							<p>
								<a href={questHref(repository, m.path)}>About this milestone</a>
							</p>
							<ul class="log">
								{mine.map((q) => (
									<Row b={b} quest={q} />
								))}
							</ul>
						</details>
					);
				})}
			</section>
		</Layout>
	);
}

/** Each quest or date a blocker comes down to, innermost first. */
function leaves(blockers: Blocker[]): Blocker[] {
	return blockers.flatMap((x) => (x.blockers.length ? leaves(x.blockers) : [x]));
}

/** One quest's page: its state, claim, blockers, CI, and its Markdown. */
export function QuestPage(props: { b: Board; path: string; doc: string; user: User; now: number; children?: Child }) {
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
		{ label: repository, href: boardHref(repository) },
		...parents(b, doc.path).map((p) => ({ label: name(p), href: questHref(repository, p.path) })),
		{ label: name(doc), href: questHref(repository, doc.path) },
	];
	const blocked = quest?.status === "blocked" ? leaves(holdsBack(b, doc.path, props.now, b.zone)) : [];
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
					{quest ? <State quest={quest} /> : <span class="muted">Epic</span>}
					{quest?.pull && (
						<span>
							<a href={quest.pull.url}>#{quest.pull.number}</a> by {quest.pull.author}
						</span>
					)}
					{quest?.status === "claimed" && !quest.pull && <span class="muted">branch pushed, no PR yet</span>}
					<a href={blob(b, doc.path)}>Source</a>
				</p>
				{blocked.length > 0 && (
					<p class="blocked-by">
						Blocked by{" "}
						{blocked.map((x, i) => {
							const target = x.path ? b.docs.find((d) => d.path === x.path) : undefined;
							return (
								<>
									{i > 0 && ", "}
									{target ? <a href={questHref(repository, target.path)}>{name(target)}</a> : x.text}
								</>
							);
						})}
					</p>
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
