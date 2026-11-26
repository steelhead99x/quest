import type { Repositories } from "./github/repos.ts";
import { Difficulty, Entry, Heading, Layout, type User } from "./layout.tsx";

const description =
	"A quest log for your repo and your agents, on your phone: what is ready to start, what is in review, and each pull request's checks.";

/** The home page: sign-in, or the signed-in person's repositories. */
export function Home(props: { user: User | null; install: string; repos: Repositories | null; origin: string }) {
	return (
		<Layout description={description} path="/" user={props.user} origin={props.origin}>
			{props.repos ? <Repos repos={props.repos} install={props.install} /> : <Pitch install={props.install} />}
		</Layout>
	);
}

/** The signed-out home page: the hook, a picture of a board, what the site shows, and how to start. */
function Pitch(props: { install: string }) {
	return (
		<>
			<section class="wrap hero">
				<div class="hero-copy">
					<h1>A quest log for your repo and your agents</h1>
					<p class="lede">Readable plans. Explicit dependencies. Reviewable Git changes.</p>
					<p>
						This site shows your repository's quest tree on your phone: what's ready to start, what's in
						review, and each pull request's checks.
					</p>
					<p class="actions">
						<a class="button primary" href="/sign-in?next=%2F">
							Sign in with GitHub
						</a>
						<a class="button quiet" href={props.install}>
							Install the App
						</a>
					</p>
				</div>
				{/* The social image's sample quests, drawn as a chain: one unblocks the next. */}
				<figure class="sample">
					<ol class="chain" aria-label="Example quests">
						<Entry title="Add the CSV endpoint" status="ready" size="S">
							<Difficulty size="S" />
							<span class="entry-status ql-ready">Ready</span>
							<span>unblocks 1</span>
						</Entry>
						<Entry title="Add a download button" status="blocked" size="M">
							<Difficulty size="M" />
							<span class="entry-status ql-blocked">Blocked</span>
							<span>by Add the CSV endpoint</span>
						</Entry>
					</ol>
					<ul class="log sample-review" aria-label="Example quest in review">
						<Entry title="Build the quest board" status="review" size="L">
							<Difficulty size="L" />
							<span class="entry-status ql-review">In review</span>
							<span>#41, checks passed</span>
						</Entry>
					</ul>
					<figcaption class="muted">Example quests, as a board lists them.</figcaption>
				</figure>
			</section>
			<section class="wrap pitch">
				<h2>What you see</h2>
				<dl class="features">
					<div>
						<dt>What to start next</dt>
						<dd>
							Ready quests in the order <code>quest unblocked</code> gives, the ones that unblock the most
							first, and what each blocked quest waits on.
						</dd>
					</div>
					<div>
						<dt>Each pull request's checks</dt>
						<dd>
							The checks and workflow runs on every claimed quest. Re-run failed jobs, or start a
							workflow, from your phone.
						</dd>
					</div>
					<div>
						<dt>How quests merged</dt>
						<dd>
							For the last 30 days: size, the model that wrote it, review score and rounds, and hours from
							claim to merge.
						</dd>
					</div>
				</dl>
			</section>
			<section class="wrap pitch">
				<h2>Set it up</h2>
				<ol class="steps">
					<li>
						<span>
							<a href={props.install}>Install the Quest App</a> on the repositories you plan in. They need
							a quest tree; <code>quest init</code> starts one.
						</span>
					</li>
					<li>
						<span>Sign in with GitHub. The site reads only what the App can.</span>
					</li>
					<li>
						<span>
							Open a repository to see its board, and add the site to your home screen from your browser.
						</span>
					</li>
				</ol>
			</section>
		</>
	);
}

function Repos(props: { repos: Repositories; install: string }) {
	const { installations, more } = props.repos;
	return (
		<section class="wrap section">
			<header class="page-head">
				<h1>Repositories</h1>
				<a class="button quiet" href={props.install}>
					Add a repository
				</a>
			</header>
			{installations.length === 0 && (
				<p class="muted">
					The App isn't on any repository you can read yet. <a href={props.install}>Install it</a>.
				</p>
			)}
			{installations.map((i) => (
				<section class="block">
					<Heading title={i.account} count={i.repositories.length} />
					<ul class="log">
						{i.repositories.map((r) => (
							<Entry title={r.name} href={`/repos/${r.owner}/${r.name}`}>
								{r.private && <span class="tag">Private</span>}
							</Entry>
						))}
					</ul>
					{i.more && <p class="muted">Showing the first 100.</p>}
				</section>
			))}
			{more && <p class="muted">Showing the first 10 accounts.</p>}
		</section>
	);
}

/** A page with one message, for errors, the not-found page, and an action's result. */
export function Message(props: {
	user: User | null;
	path: string;
	title: string;
	children: string;
	/** Where to go back to, the home page by default. */
	back?: string;
	/** The result on GitHub, for an action's page. */
	link?: string;
}) {
	return (
		<Layout title={props.title} description={props.title} path={props.path} user={props.user}>
			<section class="wrap section">
				<h1>{props.title}</h1>
				<p>{props.children}</p>
				<p class="actions">
					<a class="button primary" href={props.back ?? "/"}>
						Back
					</a>
					{props.link && (
						<a class="button quiet" href={props.link}>
							View on GitHub
						</a>
					)}
				</p>
			</section>
		</Layout>
	);
}

/** What the service worker shows offline in place of a page it may not keep. */
export function Offline() {
	return (
		<Layout title="Offline" description="You're offline." path="/offline" user={null}>
			<section class="wrap section">
				<h1>You're offline</h1>
				<p>Pages for signed-in repositories aren't kept on this device. Reconnect to see them.</p>
			</section>
		</Layout>
	);
}
