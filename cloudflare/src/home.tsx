import type { Repositories } from "./github/repos.ts";
import { Layout, type User } from "./layout.tsx";

const description = "A quest log for your repo and your agents: quest stats, PR checks, and re-runs, on your phone.";

/** The home page: sign-in, or the signed-in person's repositories. */
export function Home(props: { user: User | null; install: string; repos: Repositories | null }) {
	return (
		<Layout description={description} path="/" user={props.user}>
			{props.repos ? (
				<Repos repos={props.repos} install={props.install} />
			) : (
				<section class="wrap hero">
					<h1>A quest log for your repo and your agents</h1>
					<p class="lede">Quest stats, PR checks, and re-runs, on your phone.</p>
					<p class="actions">
						<a class="button primary" href="/sign-in?next=%2F">
							Sign in with GitHub
						</a>
					</p>
					<p class="muted">
						New here? <a href={props.install}>Install the App</a> on the repositories you plan in.
					</p>
				</section>
			)}
		</Layout>
	);
}

function Repos(props: { repos: Repositories; install: string }) {
	const { installations, more } = props.repos;
	return (
		<section class="wrap section">
			<h1>Repositories</h1>
			{installations.length === 0 && (
				<p class="muted">
					The App isn't on any repository you can read yet. <a href={props.install}>Install it</a>.
				</p>
			)}
			{installations.map((i) => (
				<div class="group">
					<h2 class="group-title">{i.account}</h2>
					<ul class="log">
						{i.repositories.map((r) => (
							<li class="entry plain">
								<a class="entry-title" href={`/repos/${r.owner}/${r.name}`}>
									{r.name}
								</a>
								{r.private && <span class="entry-meta muted">Private</span>}
							</li>
						))}
					</ul>
					{i.more && <p class="muted">Showing the first 100.</p>}
				</div>
			))}
			{more && <p class="muted">Showing the first 10 accounts.</p>}
			<p class="muted">
				<a href={props.install}>Add a repository</a>
			</p>
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
					{props.link && <a href={props.link}>View on GitHub</a>}
					<a href={props.back ?? "/"}>Back</a>
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
