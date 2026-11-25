import type { Repositories } from "./github/repos.ts";
import { Layout, type User } from "./layout.tsx";

const description = "A quest log for your repo and your agents: quest stats, PR CI, and re-runs, on any phone.";

/** The home page: the pitch and sign-in, or the signed-in person's repositories. */
export function Home(props: { user: User | null; install: string; repos: Repositories | null }) {
	return (
		<Layout description={description} path="/" user={props.user}>
			<section class="wrap hero">
				<p class="ql-eyebrow">Quest log</p>
				<h1>A quest log for your repo and your agents</h1>
				<p class="lede">
					Readable plans, explicit dependencies, and reviewable Git changes, with each quest's PR and CI one
					tap away. Add it to your home screen.
				</p>
				{!props.user && (
					<p class="actions">
						<a class="button primary" href="/sign-in?next=%2F">
							Sign in with GitHub
						</a>
						<a class="button quiet" href={props.install}>
							Install the App
						</a>
					</p>
				)}
			</section>
			{props.repos && <Repos repos={props.repos} install={props.install} />}
		</Layout>
	);
}

function Repos(props: { repos: Repositories; install: string }) {
	const { installations, more } = props.repos;
	return (
		<section class="wrap section">
			<h2>Your repositories</h2>
			{installations.length === 0 && (
				<p class="muted">
					The App is not installed on any repository you can read. <a href={props.install}>Install it</a> on
					the repositories whose quests you want to see.
				</p>
			)}
			{installations.map((i) => (
				<div class="ql-panel epic">
					<p class="ql-eyebrow">{i.account}</p>
					<ul class="log">
						{i.repositories.map((r) => (
							<li class="entry">
								<a class="entry-title" href={`/repos/${r.owner}/${r.name}`}>
									{r.owner}/{r.name}
								</a>
								{r.private && <span class="entry-meta muted">private</span>}
							</li>
						))}
					</ul>
					{i.more && <p class="muted">Only the first 100 repositories of this installation are listed.</p>}
				</div>
			))}
			{more && <p class="muted">Only the first 10 installations are listed.</p>}
			<p class="muted">
				Missing one? <a href={props.install}>Add it to the App's installation.</a>
			</p>
		</section>
	);
}

/** A page with one message, for errors and the not-found page. */
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
				{props.link && (
					<p>
						<a href={props.link}>See it on GitHub</a>
					</p>
				)}
				<p>
					<a href={props.back ?? "/"}>Back to the quest log</a>
				</p>
			</section>
		</Layout>
	);
}
