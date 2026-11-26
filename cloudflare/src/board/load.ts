// Load what a board shows from GitHub in one GraphQL request: the default
// branch's quest tree with every file's text, the open pull requests, and the
// quest branches. One request keeps any tree within the page's budget.

import { parse as parseYaml } from "yaml";
import type { GitHub } from "../github/client.ts";

/** How many directories below `quest/` the query reads; deeper files are reported, not dropped silently. */
export const DEPTH = 6;
/** The most quest files one board holds. */
export const MAX_DOCUMENTS = 1000;
/** The most bytes the board's answer may hold: a large tree plus a hundred PR bodies. */
export const MAX_ANSWER = 12 * 1024 * 1024;
/** Open pull requests and quest branches read, earliest first. */
export const MAX_PULLS = 100;
export const MAX_BRANCHES = 100;

/** An open pull request, as the board reads claims and hand-backs from it. */
export interface Pull {
	number: number;
	url: string;
	title: string;
	draft: boolean;
	/** Its head branch, which names the quest it claims. */
	branch: string;
	/** The head commit, whose checks and workflow runs the quest page shows. */
	head: string;
	/** The repository the PR is open against, whose Actions and Checks hold its CI: a fork's board may show its upstream's. */
	repository: string;
	author: string;
	body: string;
	created: string;
}

/** A workflow file on the default branch. */
export interface Workflow {
	/** Its file name, which GitHub's API takes as the workflow's id. */
	file: string;
	name: string;
	/** It has a `workflow_dispatch` trigger, so the site can start it. */
	dispatch: boolean;
	/** Dispatching it needs an input with no default, which the site's form cannot give; it starts on GitHub. */
	inputs: boolean;
}

/** A repository's quest tree and what claims it, at one commit. */
export interface Tree {
	repository: string;
	url: string;
	private: boolean;
	branch: string;
	commit: string;
	committed: string;
	documents: { path: string; content: string }[];
	pulls: Pull[];
	/** Where claims live: the nearest fork ancestor keeping the quest tree, or the repository itself. */
	upstream: string;
	/** Quest branches holding a claim, such as `quest/m0/foo`, in the repository or its upstream. */
	branches: string[];
	workflows: Workflow[];
	/** What the board could not read in full, said on the page. */
	gaps: string[];
}

/** The repository is missing, private to someone else, or not shared with the App. */
export class NotFound extends Error {}

/** One level of the tree, nesting `depth` more inside it. */
function entries(depth: number): string {
	const inner = depth > 0 ? ` ... on Tree { ${entries(depth - 1)} }` : "";
	return `entries { name type object { ... on Blob { text isTruncated byteSize }${inner} } }`;
}

/** How many fork ancestors the query reads for one keeping the quest tree, as `quest start`'s upstream walk does. */
export const ANCESTORS = 3;

/** A repository's open PRs and quest branches, each branch with its tip and the heads of PRs merged from it. */
const CLAIMS = `
		pullRequests(states: OPEN, first: ${MAX_PULLS}, orderBy: { field: CREATED_AT, direction: ASC }) {
			totalCount nodes { number url title isDraft headRefName headRefOid createdAt body author { login } }
		}
		refs(refPrefix: "refs/heads/quest/", first: ${MAX_BRANCHES}) {
			totalCount nodes { name target { oid } associatedPullRequests(states: MERGED, first: 10) { nodes { headRefOid } } }
		}`;

/** A repository's parent, and whether its default branch keeps the quest tree, nesting `depth` more. */
function parents(depth: number): string {
	if (depth === 0) return "";
	return `parent { nameWithOwner tree: object(expression: "HEAD:quest/README.md") { id } ${parents(depth - 1)} }`;
}

/** The board's query. */
export const QUERY = `query Board($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		nameWithOwner url isPrivate
		defaultBranchRef { name target { oid ... on Commit { committedDate } } }
		object(expression: "HEAD:quest") { ... on Tree { ${entries(DEPTH)} } }
		workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name type object { ... on Blob { text } } } } }
		${parents(ANCESTORS)}
		${CLAIMS}
	}
}`;

/** The claims query, for a fork's upstream. */
export const UPSTREAM = `query Upstream($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) { ${CLAIMS} }
}`;

type Entry = {
	name: string;
	type: string;
	object: { text?: string | null; isTruncated?: boolean; entries?: Entry[] } | null;
};

/** Fetch a repository's tree. */
export async function load(github: GitHub, owner: string, name: string): Promise<Tree> {
	const answer = await github.post<{ data?: { repository: unknown }; errors?: { type?: string; message: string }[] }>(
		"/graphql",
		{ query: QUERY, variables: { owner, name } },
		MAX_ANSWER,
	);
	if (answer?.errors?.some((e) => e.type === "NOT_FOUND")) throw new NotFound(`${owner}/${name}`);
	if (answer?.errors?.length) throw new Error(`GitHub's GraphQL API refused the board: ${answer.errors[0]!.message}`);
	if (!answer?.data?.repository) throw new NotFound(`${owner}/${name}`);
	const t = tree(answer.data.repository);
	if (t.upstream === t.repository) return t;
	// A fork's claims live upstream as well as in the fork, as `quest start` reads them.
	const [upOwner, upName] = t.upstream.split("/");
	const up = await github.post<{ data?: { repository: unknown }; errors?: { message: string }[] }>(
		"/graphql",
		{ query: UPSTREAM, variables: { owner: upOwner, name: upName } },
		MAX_ANSWER,
	);
	if (up?.errors?.length || !up?.data?.repository)
		throw new Error(
			`GitHub's GraphQL API refused ${t.upstream}'s claims: ${up?.errors?.[0]?.message ?? "no repository"}`,
		);
	return merge(t, claims(up.data.repository, t.upstream));
}

/** The nearest ancestor, up to ANCESTORS, whose default branch keeps the quest tree, walking up from `r`. */
export function upstreamOf(r: Record<string, any>): string {
	let up = String(r.nameWithOwner);
	for (let node = r.parent, depth = 0; node && depth < ANCESTORS; node = node.parent, depth++) {
		if (!node.tree) break;
		up = String(node.nameWithOwner);
	}
	return up;
}

/** One repository's claims: its open PRs, and its quest branches whose work has not landed. */
export function claims(
	r: Record<string, any>,
	repository: string,
): { pulls: Pull[]; branches: string[]; gaps: string[] } {
	const gaps: string[] = [];
	const pulls = r?.pullRequests;
	if (!Array.isArray(pulls?.nodes)) throw new Error(`GitHub's answer has no pull requests for ${repository}`);
	if (pulls.totalCount > MAX_PULLS)
		gaps.push(`only ${repository}'s ${MAX_PULLS} oldest open pull requests are read for claims`);
	const refs = r.refs;
	if (!Array.isArray(refs?.nodes)) throw new Error(`GitHub's answer has no branches for ${repository}`);
	if (refs.totalCount > MAX_BRANCHES) gaps.push(`only ${MAX_BRANCHES} of ${repository}'s quest branches are read`);
	return {
		pulls: pulls.nodes.map((p: any): Pull => ({
			number: Number(p.number),
			url: String(p.url),
			title: String(p.title),
			draft: p.isDraft === true,
			branch: String(p.headRefName),
			head: String(p.headRefOid),
			repository,
			author: String(p.author?.login ?? "ghost"),
			body: String(p.body ?? ""),
			created: String(p.createdAt),
		})),
		// A branch whose tip is a merged PR's head holds nothing: its work landed.
		branches: refs.nodes
			.filter((n: any) => {
				const tip = n?.target?.oid;
				const merged: unknown[] = n?.associatedPullRequests?.nodes ?? [];
				return !merged.some((m: any) => typeof tip === "string" && m?.headRefOid === tip);
			})
			.map((n: { name: string }) => `quest/${n.name}`),
		gaps,
	};
}

/** A fork's tree with its upstream's claims added: open PRs from both, earliest first, and either's branches. */
export function merge(t: Tree, up: { pulls: Pull[]; branches: string[]; gaps: string[] }): Tree {
	const pulls = [...new Map([...up.pulls, ...t.pulls].map((p) => [p.url, p])).values()].sort(
		(a, b) => Date.parse(a.created) - Date.parse(b.created) || a.number - b.number,
	);
	return { ...t, pulls, branches: [...new Set([...up.branches, ...t.branches])], gaps: [...t.gaps, ...up.gaps] };
}

/** Read the query's answer, refusing one whose shape is not the query's. */
export function tree(value: unknown): Tree {
	const r = value as Record<string, any>;
	const fail = (what: string) => {
		throw new Error(`GitHub's board answer has no ${what}`);
	};
	if (typeof r?.nameWithOwner !== "string") fail("repository name");
	const head = r.defaultBranchRef;
	if (typeof head?.name !== "string" || typeof head?.target?.oid !== "string") fail("default branch");
	const gaps: string[] = [];
	const documents: Tree["documents"] = [];
	const walk = (dir: string, list: Entry[] | undefined, depth: number) => {
		if (!Array.isArray(list)) return;
		for (const e of list) {
			if (typeof e?.name !== "string" || e.name.includes("/")) fail("well-formed tree entry");
			const path = `${dir}/${e.name}`;
			if (e.type === "tree") {
				if (e.object?.entries === undefined)
					gaps.push(`${path}/ is deeper than ${DEPTH} directories; its quests are not shown`);
				else walk(path, e.object.entries, depth + 1);
			} else if (e.type === "blob" && e.name.endsWith(".md")) {
				if (e.object?.isTruncated || typeof e.object?.text !== "string") {
					gaps.push(`${path} is too large or not text; it is not shown`);
					continue;
				}
				if (documents.length >= MAX_DOCUMENTS) {
					gaps.push(`only the first ${MAX_DOCUMENTS} quest files are shown`);
					return;
				}
				documents.push({ path, content: e.object.text });
			}
		}
	};
	walk("quest", r.object?.entries, 0);
	if (!Array.isArray(r.pullRequests?.nodes)) fail("pull requests");
	if (!Array.isArray(r.refs?.nodes)) fail("branches");
	const own = claims(r, r.nameWithOwner);
	return {
		repository: r.nameWithOwner,
		url: String(r.url),
		private: r.isPrivate === true,
		branch: head.name,
		commit: head.target.oid,
		committed: String(head.target.committedDate ?? ""),
		documents,
		upstream: upstreamOf(r),
		pulls: own.pulls,
		branches: own.branches,
		workflows: workflows(r.workflows?.entries),
		gaps: [...gaps, ...own.gaps],
	};
}

/** The workflow files, read for their names, whether they can be dispatched, and whether that needs inputs. */
export function workflows(list: unknown): Workflow[] {
	if (!Array.isArray(list)) return [];
	return list
		.filter((e) => e?.type === "blob" && /\.ya?ml$/.test(String(e.name)) && typeof e.object?.text === "string")
		.map((e) => ({ file: String(e.name), ...triggers(e.object.text, String(e.name)) }))
		.sort((a, b) => a.file.localeCompare(b.file));
}

/** A workflow's name and dispatch trigger, read from its YAML; a file that does not parse cannot be dispatched. */
export function triggers(text: string, file: string): Omit<Workflow, "file"> {
	let doc: Record<string, unknown>;
	try {
		const parsed = parseYaml(text, { maxAliasCount: 50 }) as unknown;
		if (typeof parsed !== "object" || parsed === null) return { name: file, dispatch: false, inputs: false };
		doc = parsed as Record<string, unknown>;
	} catch {
		return { name: file, dispatch: false, inputs: false };
	}
	const name = typeof doc.name === "string" && doc.name ? doc.name : file;
	// YAML 1.1 readers turn the bare key `on` into true; accept either.
	const on = doc.on ?? doc.true;
	if (on === "workflow_dispatch") return { name, dispatch: true, inputs: false };
	if (Array.isArray(on)) return { name, dispatch: on.includes("workflow_dispatch"), inputs: false };
	if (typeof on !== "object" || on === null || !("workflow_dispatch" in on))
		return { name, dispatch: false, inputs: false };
	const spec = (on as Record<string, unknown>).workflow_dispatch as { inputs?: Record<string, unknown> } | null;
	const inputs = Object.values(spec?.inputs ?? {}).some((input) => {
		const i = input as { required?: unknown; default?: unknown } | null;
		return i?.required === true && i.default === undefined;
	});
	return { name, dispatch: true, inputs };
}
