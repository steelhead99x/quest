// Who holds a quest on GitHub: its claim branch upstream or in the head fork, unless that branch is a
// merged PR's head, or the earliest open PR from a branch of that name in either.
import {
	type Claim,
	type ClaimSource,
	type ClaimSources,
	type Holdings,
	type OpenPull,
	type Repository,
	handedBack,
	landed,
} from "../core";
import { type GitHubReader, object, repositoryPath, string } from "./client";

/** Every open PR in `repository`, from any head repository. */
export async function openPullRequests(github: GitHubReader, repository: Repository): Promise<OpenPull[]> {
	const rows = await github.all(`${repositoryPath(repository)}/pulls?state=open&per_page=100`);
	return rows.map((row) => {
		const head = object(row.head);
		const repo = head.repo === null || head.repo === undefined ? null : object(head.repo);
		return {
			number: Number(row.number),
			url: string(row.html_url),
			branch: string(head.ref),
			base: string(object(row.base).ref),
			head: repo === null ? null : string(repo.full_name),
			...(typeof head.sha === "string" ? { sha: head.sha } : {}),
			draft: row.draft === true,
			created: Date.parse(string(row.created_at)),
			updated: Date.parse(string(row.updated_at)),
			handedBack: typeof row.body === "string" && handedBack(row.body),
			body: typeof row.body === "string" ? row.body : "",
		};
	});
}

/** The open PRs from `branch`, earliest first: the first one holds the claim. */
export function pullsFrom(pulls: OpenPull[], branch: string): OpenPull[] {
	return pulls.filter((pull) => pull.branch === branch).sort((a, b) => a.created - b.created || a.number - b.number);
}

/** The `quest/*` branches among `refs`, full ref names with their tips, by branch name. */
export function questBranches(refs: Map<string, string>): Map<string, string> {
	const branches = new Map<string, string>();
	for (const [ref, sha] of refs)
		if (ref.startsWith("refs/heads/quest/")) branches.set(ref.slice("refs/heads/".length), sha);
	return branches;
}

/** The `quest/*` branches of `repository`, with their tips. */
export async function claimBranches(github: GitHubReader, repository: Repository): Promise<Map<string, string>> {
	const rows = await github.all(`${repositoryPath(repository)}/git/matching-refs/heads/quest/`);
	return questBranches(new Map(rows.map((row) => [string(row.ref), string(object(row.object).sha)])));
}

/**
 * Which of `branches` someone holds: the earliest open PR from it in either source, else its branch in
 * either. A branch whose tip is a merged PR's head holds nothing: its work landed. A closed, unmerged
 * PR's branch still holds its quest, since that work may be wanted back. A fork's own branches and PRs
 * count, so a claim pushed there is seen before its PR opens. Tips a source leaves out are read here.
 */
export async function held(github: GitHubReader, sources: ClaimSources, branches: string[]): Promise<Holdings> {
	const { upstream, fork } = sources;
	const read = async (source: ClaimSource) => ({
		repository: source.repository,
		tips: source.tips ?? (await claimBranches(github, source.repository)),
	});
	const listed = fork ? [upstream, fork] : [upstream];
	const [all, pulls] = await Promise.all([
		Promise.all(listed.map(read)),
		Promise.all(listed.map((source) => openPullRequests(github, source.repository))).then((each) => each.flat()),
	]);
	const pushTo = all[all.length - 1];
	const landed = new Map<string, string>();
	const holds = async (branch: string): Promise<Claim | null> => {
		const pull = pullsFrom(pulls, branch)[0] ?? null;
		if (pull !== null) return { branch, url: pull.url, pull };
		let holding = false;
		for (const source of all) {
			const tip = source.tips.get(branch);
			if (tip === undefined) continue;
			if ((await mergedPull(github, upstream.repository, source.repository, branch, tip)) !== null) {
				if (source === pushTo) landed.set(branch, tip);
			} else {
				holding = true;
			}
		}
		return holding ? { branch, url: null, pull: null } : null;
	};
	const found = await Promise.all([...new Set(branches)].sort().map(holds));
	return { claims: found.filter((claim): claim is Claim => claim !== null), landed };
}

/** The URL of the PR from `head`'s `branch` that merged into `repository` with `tip` as its head, or `null`. */
export async function mergedPull(
	github: GitHubReader,
	repository: Repository,
	head: Repository,
	branch: string,
	tip: string,
): Promise<string | null> {
	const query = new URLSearchParams({ state: "closed", head: `${head.owner}:${branch}`, per_page: "100" });
	const rows = await github.all(`${repositoryPath(repository)}/pulls?${query}`);
	const pull = landed(
		tip,
		rows.map((row) => ({
			head: string(object(row.head).sha),
			merged: typeof row.merged_at === "string",
			url: string(row.html_url),
		})),
	);
	return pull?.url ?? null;
}
