import type { Child } from "hono/jsx";

// The site shell: every HTML page the Worker serves renders inside Layout.
// Colours, type, and glyphs follow design/theme.md; tokens live in /theme/theme.css,
// and the theme's fonts are served from /fonts (scripts/build.ts).

export const repo = "https://github.com/moq-dev/quest";

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
	/** The site's origin, for the social preview's absolute URLs; given on public pages. */
	origin?: string;
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
				{/* The display face draws every heading, so fetch it before the stylesheet asks. */}
				<link
					rel="preload"
					href="/fonts/barlow-condensed-latin-700-normal.woff2"
					as="font"
					type="font/woff2"
					crossorigin=""
				/>
				<link rel="stylesheet" href="/theme/theme.css" />
				<link rel="stylesheet" href="/site.css" />
				<script src="/app.js" defer></script>
				{props.origin && (
					<>
						<meta property="og:type" content="website" />
						<meta property="og:title" content={title} />
						<meta property="og:description" content={props.description} />
						<meta property="og:url" content={new URL(props.path, props.origin).href} />
						<meta property="og:image" content={new URL("/theme/og.png", props.origin).href} />
						<meta property="og:image:width" content="1280" />
						<meta property="og:image:height" content="640" />
						<meta
							property="og:image:alt"
							content="Quest: a quest log for your repo and your agents. Readable plans, explicit dependencies, reviewable Git changes."
						/>
						<meta name="twitter:card" content="summary_large_image" />
					</>
				)}
			</head>
			<body>
				<header class="site-header">
					<nav class="wrap nav" aria-label="Site">
						<a class="brand" href="/">
							<img src="/theme/logo.svg" alt="" width="32" height="32" />
							Quest
						</a>
						<span class="account">
							{props.user ? (
								<>
									<span class="muted">{props.user.login}</span>
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
						<a href={repo}>Source</a> · MIT or Apache-2.0
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

/**
 * A log entry, drawn like design/theme/og.svg's: a panel edged in the quest's
 * size colour (or `tone`'s, for a CI run), its marker beside the title, and a
 * meta line under it. Pass the meta line, starting with the size and state
 * labels, as children.
 */
export function Entry(props: {
	title: Child;
	href?: string;
	status?: Status;
	size?: Size | null;
	/** An edge colour for a row with no size: a size or status class such as `ql-s`. */
	tone?: string;
	children?: Child;
}) {
	const edge = props.size ? `edge-${props.size.toLowerCase()}` : props.tone ? `edge-${props.tone}` : "";
	return (
		<li class={`entry ${edge} ${props.status ? "" : "plain"}`}>
			{props.status && <Marker status={props.status} />}
			{props.href ? (
				<a class="entry-title" href={props.href}>
					{props.title}
				</a>
			) : (
				<span class="entry-title">{props.title}</span>
			)}
			{props.children && <span class="entry-meta">{props.children}</span>}
		</li>
	);
}

/** A section's heading: a small label in the accent over the title, and an optional count. */
export function Heading(props: { eyebrow?: string; title: string; count?: number; id?: string }) {
	return (
		<header class="block-head">
			{props.eyebrow && <p class="ql-eyebrow">{props.eyebrow}</p>}
			<h2 id={props.id}>
				{props.title}
				{props.count !== undefined && <span class="count">{props.count}</span>}
			</h2>
		</header>
	);
}
