// Load what a board shows from GitHub in one GraphQL request: the default
// branch's quest tree with every file's text, the open pull requests, and the
// quest branches. One request keeps any tree within the page's budget.

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
	author: string;
	body: string;
	created: string;
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
	/** Quest branches on the repository, such as `quest/m0/foo`. */
	branches: string[];
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

/** The board's query. */
export const QUERY = `query Board($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		nameWithOwner url isPrivate
		defaultBranchRef { name target { oid ... on Commit { committedDate } } }
		object(expression: "HEAD:quest") { ... on Tree { ${entries(DEPTH)} } }
		pullRequests(states: OPEN, first: ${MAX_PULLS}, orderBy: { field: CREATED_AT, direction: ASC }) {
			totalCount nodes { number url title isDraft headRefName createdAt body author { login } }
		}
		refs(refPrefix: "refs/heads/quest/", first: ${MAX_BRANCHES}) { totalCount nodes { name } }
	}
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
	return tree(answer.data.repository);
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
	const pulls = r.pullRequests;
	if (!Array.isArray(pulls?.nodes)) fail("pull requests");
	if (pulls.totalCount > MAX_PULLS) gaps.push(`only the ${MAX_PULLS} oldest open pull requests are read for claims`);
	const refs = r.refs;
	if (!Array.isArray(refs?.nodes)) fail("branches");
	if (refs.totalCount > MAX_BRANCHES) gaps.push(`only ${MAX_BRANCHES} quest branches are read for claims`);
	return {
		repository: r.nameWithOwner,
		url: String(r.url),
		private: r.isPrivate === true,
		branch: head.name,
		commit: head.target.oid,
		committed: String(head.target.committedDate ?? ""),
		documents,
		pulls: pulls.nodes.map((p: any): Pull => ({
			number: Number(p.number),
			url: String(p.url),
			title: String(p.title),
			draft: p.isDraft === true,
			branch: String(p.headRefName),
			author: String(p.author?.login ?? "ghost"),
			body: String(p.body ?? ""),
			created: String(p.createdAt),
		})),
		branches: refs.nodes.map((n: { name: string }) => `quest/${n.name}`),
		gaps,
	};
}
