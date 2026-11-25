import type { Child } from "hono/jsx";

// The site shell: every HTML page the Worker serves renders inside Layout.
// Colours, type, and glyphs follow design/theme.md; tokens live in /theme/theme.css.

export const repo = "https://github.com/moq-dev/quest";

const fonts =
	"https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;600&display=swap";

/** The signed-in person, as the header shows them. */
export type User = { login: string };

/** A step in the breadcrumb trail; the last one is the current page. */
export type Crumb = { label: string; href: string };

/** What every page tells the layout. */
export type Page = {
	/** Omitted on the home page, which uses the full hook as its title. */
	title?: string;
	description: string;
	/** The current path, where signing in returns. */
	path: string;
	user: User | null;
	crumbs?: Crumb[];
};

/** The page shell. */
export function Layout(props: Page & { children: Child }) {
	const title = props.title ? `${props.title} · Quest` : "Quest: a quest log for your repo and your agents";
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
				<title>{title}</title>
				<meta name="description" content={props.description} />
				<meta name="theme-color" content="#0a0c11" />
				<link rel="icon" href="/theme/logo.svg" type="image/svg+xml" />
				<link rel="manifest" href="/manifest.webmanifest" />
				<link rel="apple-touch-icon" href="/theme/icon-192.png" />
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
				<link rel="stylesheet" href={fonts} />
				<link rel="stylesheet" href="/theme/theme.css" />
				<link rel="stylesheet" href="/site.css" />
				<script src="/app.js" defer></script>
			</head>
			<body>
				<header class="site-header">
					<nav class="wrap nav" aria-label="Site">
						<a class="brand" href="/">
							<img src="/theme/logo.svg" alt="" width="32" height="32" />
							Quest
						</a>
						<a href={repo}>GitHub</a>
						<span class="account">
							{props.user ? (
								<>
									<span class="muted">Signed in as {props.user.login}.</span>
									<form method="post" action="/sign-out">
										<button class="button quiet">Sign out</button>
									</form>
								</>
							) : (
								<a class="button quiet" href={`/sign-in?next=${encodeURIComponent(props.path)}`}>
									Sign in
								</a>
							)}
						</span>
					</nav>
				</header>
				{props.crumbs && <Crumbs crumbs={props.crumbs} />}
				<main>{props.children}</main>
				<footer class="wrap site-footer">
					<p>
						<a href="/">Quest</a> · <a href={repo}>GitHub</a> · MIT or Apache-2.0
					</p>
				</footer>
			</body>
		</html>
	);
}

function Crumbs(props: { crumbs: Crumb[] }) {
	return (
		<nav class="wrap crumbs" aria-label="Breadcrumb">
			<ol>
				{props.crumbs.map((crumb, i) =>
					i === props.crumbs.length - 1 ? (
						<li aria-current="page">{crumb.label}</li>
					) : (
						<li>
							<a href={crumb.href}>{crumb.label}</a>
						</li>
					),
				)}
			</ol>
		</nav>
	);
}

/** The ready `!` marker, drawn like the mark. Colour comes from the marker class. */
export function Bang() {
	return (
		<svg class="glyph" viewBox="-10 -22 20 44" aria-hidden="true">
			<g fill="currentColor" stroke="#0a0c11" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke">
				<path d="M-7 -19 H7 L3.5 4 H-3.5 Z" />
				<rect x="-5" y="8.5" width="10" height="10" rx="2" />
			</g>
		</svg>
	);
}

/** The in-review `?` marker. */
export function Query() {
	return (
		<svg class="glyph" viewBox="-12 -22 24 44" aria-hidden="true">
			<g stroke-linecap="round" stroke-linejoin="round">
				<path d="M-8 -9 C-8 -21 8 -21 8 -9 C8 -1 0 -1 0 5" fill="none" stroke="#0a0c11" stroke-width="9.5" />
				<path d="M-8 -9 C-8 -21 8 -21 8 -9 C8 -1 0 -1 0 5" fill="none" stroke="currentColor" stroke-width="5" />
				<rect
					x="-5"
					y="8.5"
					width="10"
					height="10"
					rx="2"
					fill="currentColor"
					stroke="#0a0c11"
					stroke-width="2.4"
					paint-order="stroke"
				/>
			</g>
		</svg>
	);
}

/** A quest's state on the board. */
export type Status = "ready" | "blocked" | "claimed" | "review";

/**
 * A state's marker, per design/theme.md: an amber `!` for ready, a grey `!` for
 * blocked, and an amber `?` for a PR in review. Claimed has none. Always pair it
 * with its label.
 */
export function Marker(props: { status: Status }) {
	if (props.status === "claimed") return <span class="ql-marker" />;
	const cls = props.status === "blocked" ? "ql-blocked" : props.status === "review" ? "ql-turn-in" : "ql-available";
	return <span class={`ql-marker ${cls}`}>{props.status === "review" ? <Query /> : <Bang />}</span>;
}

export type Size = "XS" | "S" | "M" | "L" | "XL";

/** A size label in its size colour. */
export function Difficulty(props: { size: Size }) {
	return <span class={`ql-size ql-${props.size.toLowerCase()}`}>{props.size}</span>;
}
