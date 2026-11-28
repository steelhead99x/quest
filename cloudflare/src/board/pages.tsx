import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { type Blocker, questBranch } from "../../../src/core/index.ts";
import {
	type Crumb,
	Difficulty,
	Entry,
	Heading,
	Layout,
	Marker,
	type Size,
	type Status,
	type User,
} from "../layout.tsx";
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

/** A quest row, with its state label beside its marker, as design/theme.md requires. */
function Row(props: { b: Board; quest: Quest; note?: string }) {
	const { quest } = props;
	return (
		<Entry
			title={quest.title}
			href={questHref(props.b.tree.repository, quest.path)}
			status={quest.status}
			size={quest.size}
		>
			{quest.size && <Difficulty size={quest.size} />}
			<State quest={quest} />
			{quest.pull && <a href={quest.pull.url}>#{quest.pull.number}</a>}
			{props.note && <span class="muted">{props.note}</span>}
		</Entry>
	);
}

/** Each state's count as a tile: the number large, its marker and label under it. */
function Tally(props: { counts: Counts }) {
	return (
		<ul class="stats" aria-label="Quests by state">
			{ORDER.map((s) => (
				<li class={`stat stat-${s}`}>
					<strong class="stat-value">{props.counts[s]}</strong>
					<span class="stat-label">
						<Marker status={s} />
						{LABELS[s]}
					</span>
				</li>
			))}
		</ul>
	);
}

/** Each milestone's counts by state, as a row that opens its section below. */
function Milestones(props: { b: Board }) {
	return (
		<ul class="milestones" aria-label="Milestones">
			{props.b.milestones.map((m) => {
				const id = m.path.split("/")[1]!;
				return (
					<li>
						<a class="milestone-row" href={`#${id}`}>
							<span class="milestone-name">
								<code class="ident">{id}</code>
								{m.title}
							</span>
							<span class="milestone-counts">
								{ORDER.filter((s) => m.counts[s] > 0).map((s) => (
									<span class={`count-chip ql-${s}`}>
										<Marker status={s} />
										{m.counts[s]} <span class="muted">{LABELS[s].toLowerCase()}</span>
									</span>
								))}
							</span>
						</a>
					</li>
				);
			})}
		</ul>
	);
}

function Sizes(props: { b: Board }) {
	const sizes = (["XS", "S", "M", "L", "XL"] as Size[]).filter((s) => props.b.sizes[s] > 0);
	return (
		<p class="size-tally" aria-label="Open quests by size">
			{sizes.map((s) => (
				<span class="size-count">
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
						Read from <code class="ident">{b.tree.branch}</code> at{" "}
						<a href={`${b.tree.url}/commit/${b.tree.commit}`}>
							<code class="ident">{b.tree.commit.slice(0, 7)}</code>
						</a>
						.
					</p>
					<p class="head-actions">
						<a class="button quiet small" href={`${boardHref(repository)}/bench`}>
							How quests merged
						</a>
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
						<Sizes b={b} />
						<Milestones b={b} />
					</section>
				)}
				<div class="columns">
					{b.ranked.length > 0 && (
						<section class="block">
							<Heading title="Ready to start" count={b.ranked.length} />
							<ol class="log">
								{b.ranked.slice(0, READY_SHOWN).map((r) => (
									<Row
										b={b}
										quest={r.quest}
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
						<section class="block">
							<Heading title="Waiting" count={b.waiting.length} />
							<ul class="log">
								{b.waiting.slice(0, WAITING_SHOWN).map((w) => (
									<Entry
										title={
											w.path
												? (b.quests.get(w.path)?.title ??
													name(b.docs.find((d) => d.path === w.path)!))
												: w.pr!
										}
										href={w.path ? questHref(repository, w.path) : w.pr!}
										tone="wait"
									>
										<span class="entry-why">
											<span class="tag">{w.waits[0]!.party}</span> {clip(w.waits[0]!.text, 100)}
											{w.waits.length > 1 && ` (and ${w.waits.length - 1} more)`}
										</span>
									</Entry>
								))}
							</ul>
							{b.waiting.length > WAITING_SHOWN && (
								<p class="muted">{b.waiting.length - WAITING_SHOWN} more.</p>
							)}
						</section>
					)}
				</div>
				{props.children}
				{b.milestones.map((m) => {
					const mine = quests.filter((q) => q.path.startsWith(m.path.replace(/README\.md$/, "")));
					return (
						<details class="fold milestone" id={m.path.split("/")[1]}>
							<summary>
								<code class="ident">{m.path.split("/")[1]}</code>
								<span class="fold-title">{m.title}</span>
								<span class="count">{mine.length}</span>
							</summary>
							<p class="fold-link">
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
	const { title, sections } = render(
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
					<h1 id={title || undefined}>{name(doc)}</h1>
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
					<a class="source" href={blob(b, doc.path)}>
						View source
					</a>
				</p>
				{blocked.length > 0 && (
					<p class="callout blocked-by">
						<Marker status="blocked" />
						<span>
							Blocked by{" "}
							{blocked.map((x, i) => {
								const target = x.path ? b.docs.find((d) => d.path === x.path) : undefined;
								return (
									<>
										{i > 0 && ", "}
										{target ? (
											<a href={questHref(repository, target.path)}>{name(target)}</a>
										) : (
											x.text
										)}
									</>
								);
							})}
						</span>
					</p>
				)}
				{props.children}
				<div class="quest-page">
					{sections.map((s) => (
						<section>
							{s.heading && <h2 id={s.id}>{s.heading}</h2>}
							{raw(s.html)}
						</section>
					))}
				</div>
			</article>
		</Layout>
	);
}
