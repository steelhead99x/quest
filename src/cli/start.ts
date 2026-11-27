// `quest start`: claim a ready quest by pushing an empty claim commit to its
// branch and opening a draft PR from it right away, and release that claim
// while nothing but the claim commit is on the branch.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { type OpenPull, Refusal, questBranch } from "../core";
import {
	type ClaimDependencies,
	type Hosting,
	type Target,
	type Upstream,
	defaultBranch,
	ensure,
	held,
	remoteBranches,
	upstream,
	upstreamRefs,
} from "./claims";
import { GitError, git } from "./git";
import { requireRemote } from "./github";
import { ago } from "../github/hold";
import { Worktrees, canonical, derivedDefaults, mainCheckout, waiting } from "./worktree";
import { mergedPull, pullsFrom } from "../github/claims";

export interface Started {
	branch: string;
	/** The claim commit, also the local branch's tip when that branch was free. */
	sha: string;
	/** The draft PR; `null` off GitHub. */
	url: string | null;
	/**
	 * The directory in a worktree on `branch` that matches the one `quest start` ran in, to work in, when that
	 * checkout stayed on the default branch; `null` when it moved onto the claim.
	 */
	worktree: string | null;
}

/** The refusal for a quest the upstream default branch lacks: finished upstream, or not merged yet. */
export function notUpstream(path: string): Refusal {
	return new Refusal(`${path} is not on the upstream default branch; update your checkout`);
}

/**
 * Claim `path`, a quest ready in the target's upstream tree. Throws `Refusal`
 * when someone else holds it or the upstream tree lacks it. A branch left by
 * a merged PR holds nothing, so the claim replaces it with a lease on its tip.
 */
export async function startQuest(
	root: string,
	{ remote, up, base, branches, tree }: Target,
	path: string,
	title: string,
	deps: ClaimDependencies,
): Promise<Started> {
	const branch = questBranch(path);
	if (!tree.docs.some((doc) => doc.path === path)) throw notUpstream(path);
	const { claims, landed } = await held(root, up, [branch], branches);
	const [claim] = claims;
	if (claim) throw new Refusal(`${path} is held by ${describe(claim.branch, claim.pull, Date.now())}`);
	// A nonce keeps two claimers on the same base, identity, and second from building the same commit.
	const nonce = randomBytes(8).toString("hex");
	const sha = git(root, [
		"commit-tree",
		`${base}^{tree}`,
		"-p",
		base,
		"-m",
		`chore(quest): claim ${path}`,
		"-m",
		`Quest-Claim: ${nonce}`,
	]);
	// The lease expects the landed tip, or no branch at all.
	try {
		push(
			root,
			remote,
			[`--force-with-lease=refs/heads/${branch}:${landed.get(branch) ?? ""}`, `${sha}:refs/heads/${branch}`],
			`someone pushed ${branch} first`,
		);
	} catch (error) {
		if (error instanceof Refusal) throw error;
		const message = await obstructed(root, up, remote, path, branch);
		throw message === null ? error : new Refusal(message);
	}

	let url: string | null = null;
	if (up.hosting === null) {
		deps.warn(`${remote} is not on GitHub or Kixel Quest, so the claim branch was pushed without a PR`);
	} else {
		url = await openDraft(root, up.hosting, remote, path, title, branch, sha);
	}

	let worktree: string | null;
	try {
		// The repository the claim was pushed to, such as a fork, names the default branch; it may differ from the upstream's.
		const top = await place(root, defaultBranch(root, up.push), branch, sha, deps.warn);
		// A quest tree below the repository root is found again at the same place in the worktree.
		worktree = top === null ? null : join(top, git(root, ["rev-parse", "--show-prefix"]).replace(/\/$/, ""));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`claimed ${path}${url === null ? "" : ` at ${url}`}, but no checkout is on ${branch}: ${message}`,
		);
	}
	return { branch, sha, url, worktree };
}

/**
 * Why `remote` refused `branch`, when a branch there is in its way: git cannot hold a branch whose
 * name is another's directory, as `quest/m1/epic` is for `quest/m1/epic/one`. Each such branch is
 * named, with whether it is a merged PR's head, and left alone. `null` when nothing is in the way.
 */
async function obstructed(
	root: string,
	up: Upstream,
	remote: string,
	path: string,
	branch: string,
): Promise<string | null> {
	const parts = branch.split("/");
	const patterns = parts.slice(1).map((_, i) => `refs/heads/${parts.slice(0, i + 1).join("/")}`);
	let listing: string;
	try {
		listing = git(root, ["ls-remote", up.push, ...patterns, `refs/heads/${branch}/*`]);
	} catch {
		return null;
	}
	const found = listing
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [tip, ref] = line.split("\t");
			return { tip, name: ref.replace(/^refs\/heads\//, "") };
		})
		// ls-remote matches patterns against the end of a ref, so keep only the exact ancestors and descendants.
		.filter(({ name }) => branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`));
	if (found.length === 0) return null;
	const github = up.github;
	const states = await Promise.all(
		found.map(async ({ tip, name }) => {
			if (github === null) return `- ${name}: whether it is a merged PR's head is unknown off GitHub`;
			const url = await mergedPull(github.client, github.repository, github.head, name, tip);
			return `- ${name}: ${url === null ? "not a merged PR's head" : `the head of ${url}, which merged`}`;
		}),
	);
	return [
		`${path} cannot be claimed: git cannot hold ${branch} on ${remote} beside a branch named after its directory or inside it:`,
		...states,
		"Stop and report this; do not delete or rename a branch in the way.",
	].join("\n");
}

/**
 * Put work on the claim's branch without moving a checkout off the default branch: a checkout on it,
 * such as the main clone, is left alone, and the branch's worktree is returned, the one that already
 * has it checked out or else one `quest worktree` owns under `.worktrees/`. Any other checkout is put
 * on the claim, and `null` is returned.
 */
async function place(
	root: string,
	trunk: string,
	branch: string,
	sha: string,
	warn: (message: string) => void,
): Promise<string | null> {
	if (head(root) !== `refs/heads/${trunk}`) {
		checkout(root, branch, sha, warn);
		return null;
	}
	const worktrees = new Worktrees();
	const held = checkedOut(root).get(`refs/heads/${branch}`);
	if (held !== undefined) {
		// A quest worktree an earlier release left stays charged for its growth again.
		const owned = await waiting(() => worktrees.registered(canonical(held)));
		if (owned) await waiting(() => worktrees.restore(owned.id));
		checkout(held, branch, sha, warn);
		return held;
	}
	const main = mainCheckout(root);
	// The hash tells apart branches that differ only where the name keeps nothing, such as `a/b-c` and `a-b/c`,
	// or past its cut: a filename holds 255 bytes, which a long branch would overflow.
	const readable = branch.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
	const name = `${readable}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
	const earlier = await waiting(() => worktrees.registered(join(main, ".worktrees", name)));
	let path: string;
	if (earlier) {
		path = (await waiting(() => worktrees.restore(earlier.id))).path;
	} else {
		const { reserve, scratch } = derivedDefaults(main);
		path = (await worktrees.create(main, name, reserve, sha, scratch)).path;
	}
	const ref = `refs/heads/${branch}`;
	if (succeeds(path, ["rev-parse", "--verify", "--quiet", ref])) {
		// The branch is checked out nowhere, so this worktree can take it; its tip is not moved.
		const switched = succeeds(path, ["switch", "--quiet", branch]);
		warn(
			`claimed, but local branch ${branch} already exists from an earlier attempt; ` +
				`${switched ? `it is checked out in ${path}; ` : `switch ${path} to it, `}` +
				`merge the claim commit ${sha} into it, and resume that work before pushing`,
		);
	} else if (!succeeds(path, ["switch", "--quiet", "-c", branch, sha])) {
		throw new Error(`could not switch ${path} to a new ${branch}`);
	}
	return path;
}

/** The ref `root`'s HEAD names, or `null` when detached. */
function head(root: string): string | null {
	try {
		return git(root, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		return null;
	}
}

/** Each branch ref checked out in one of the repository's worktrees, with that worktree's path. */
function checkedOut(root: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const entry of git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
		const lines = entry.split("\0");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
		const ref = lines.find((line) => line.startsWith("branch "))?.slice(7);
		if (path !== undefined && ref !== undefined) found.set(ref, path);
	}
	return found;
}

/**
 * Put the checkout on the claim, so work lands on the quest's branch. The claim
 * changes no files, so this carries uncommitted changes along. Whatever cannot
 * be done safely is left as a warning saying what to run.
 */
function checkout(root: string, branch: string, sha: string, warn: (message: string) => void): void {
	const ref = `refs/heads/${branch}`;
	if (head(root) === ref) {
		// Already on the quest's branch, as after `git worktree add -b`: catch it up to the claim.
		if (!succeeds(root, ["merge", "--ff-only", "--quiet", sha])) {
			warn(`${branch} has diverged from the claim commit; merge ${sha} into it before pushing`);
		}
	} else if (succeeds(root, ["rev-parse", "--verify", "--quiet", ref])) {
		warn(
			`claimed, but local branch ${branch} already exists from an earlier attempt; ` +
				`switch to it, merge the claim commit ${sha} into it, and resume that work before pushing`,
		);
	} else if (!succeeds(root, ["switch", "--quiet", "-c", branch, sha])) {
		git(root, ["update-ref", ref, sha, ""]);
		warn(`created ${branch} but could not switch to it; run git switch ${branch}`);
	}
}

/** Open the draft PR, then keep it only if it is the earliest open PR on the branch. */
async function openDraft(
	root: string,
	hosting: Hosting,
	remote: string,
	path: string,
	title: string,
	branch: string,
	sha: string,
): Promise<string> {
	const { repository, head, defaultBranch } = hosting;
	const link = hosting.link(path);
	const body = link === null ? `Claims \`${path}\`.` : `Claims [${path}](${link}).`;
	const writes = hosting.writes();
	let created: OpenPull;
	let forge: Awaited<ReturnType<Hosting["forge"]>>;
	try {
		// Before the PR exists, so a forge that cannot be chosen takes the branch back rather than leaving a PR behind.
		forge = await hosting.forge();
		created = await writes.open({
			repository,
			head,
			branch,
			base: defaultBranch,
			title: title.replace(/^\[(XS|S|M|L|XL)\] /, ""),
			body,
			draft: true,
		});
	} catch (error) {
		// Without its PR the claim is invisible on the forge, so take the branch back.
		deleteBranch(root, remote, branch, sha);
		throw error;
	}

	// Two claimers on different repositories, such as forks, both push; the earliest PR wins. The list may predate
	// this PR's webhook, so the created PR joins it here rather than being looked for.
	let listed: OpenPull[];
	try {
		listed = (await forge.pulls(repository)).value;
	} catch (error) {
		// Unchecked, the claim may be a later one's, so take it back whole, as a refused open does.
		try {
			deleteBranch(root, remote, branch, sha);
			await writes.close({ ...repository, number: created.number });
		} catch (cleanup) {
			// Both matter: why the check failed, such as when to retry, and what was left behind.
			throw new Error(
				`${(error as Error).message}; taking back the claim on ${created.url} then failed: ${(cleanup as Error).message}`,
				{ cause: error },
			);
		}
		throw error;
	}
	const open = pullsFrom(listed, branch);
	const first = pullsFrom([...open.filter((pull) => pull.number !== created.number), created], branch)[0];
	if (first.number !== created.number) {
		deleteBranch(root, remote, branch, sha);
		await writes.close({ ...repository, number: created.number });
		throw new Refusal(`${first.url} claimed ${path} first; closed ${created.url}`);
	}
	return created.url;
}

export interface Released {
	branch: string;
	/** The PRs closed with it. */
	closed: string[];
}

/**
 * Release the claim on `path`: delete its branch on `remote` with a lease on
 * the claim commit, then close its open PR. Refuses once the branch has work on it.
 */
export async function releaseQuest(
	root: string,
	path: string,
	remote: string,
	deps: ClaimDependencies,
): Promise<Released> {
	const branch = questBranch(path);
	const up = await upstream(root, requireRemote(root, remote), deps);
	const tip = remoteBranches(root, up.push).get(branch);
	if (!tip) throw new Error(`${remote} has no branch ${branch} to release`);
	ensure(root, up.push, tip);
	const { base } = upstreamRefs(root, up.git);
	const parents = git(root, ["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1);
	// Only the claim itself: one empty commit straight on the default branch, not one following pushed work.
	const claim =
		parents.length === 1 &&
		git(root, ["rev-parse", `${tip}^{tree}`]) === git(root, ["rev-parse", `${parents[0]}^{tree}`]) &&
		succeeds(root, ["merge-base", "--is-ancestor", parents[0], base]);
	if (!claim) {
		throw new Refusal(
			`${branch} on ${remote} has work beyond its empty claim commit; close its PR yourself to abandon that work`,
		);
	}

	const pulls: OpenPull[] = [];
	const hosting = up.hosting;
	if (hosting) {
		const head = `${hosting.head.owner}/${hosting.head.repo}`.toLowerCase();
		const open = (await (await hosting.forge()).pulls(hosting.repository)).value;
		pulls.push(...pullsFrom(open, branch).filter((pull) => pull.head?.toLowerCase() === head));
	}
	// Deleting first means the lease decides: a push since the check keeps both the branch and its PR.
	deleteBranch(root, remote, branch, tip);
	for (const pull of pulls) await hosting!.writes().close({ ...hosting!.repository, number: pull.number });
	return { branch, closed: pulls.map((pull) => pull.url) };
}

/** A claim for a person deciding whether to wait, take it over, or pick other work. */
export function describe(branch: string, pull: OpenPull | null, now: number): string {
	if (pull === null) return `branch ${branch}, with no open PR`;
	// A draft without the hand-back heading is still its starter's; the others wait on the maintainer.
	const state = !pull.draft ? "ready for review" : pull.handedBack ? "draft, waiting" : "draft";
	return `${pull.url} (${state}, last active ${ago(now, pull.updated)})`;
}

/** Delete `branch` on `remote` only while its tip is still `sha`. */
function deleteBranch(root: string, remote: string, branch: string, sha: string): void {
	push(
		root,
		remote,
		[`--force-with-lease=refs/heads/${branch}:${sha}`, `:refs/heads/${branch}`],
		`${branch} moved on ${remote}, so it was kept`,
	);
}

/**
 * Push, forcing only where a lease in `args` allows. A rejection, which means the remote ref is not what
 * this push expects, is a `Refusal` with `rejected`; anything else fails.
 */
function push(root: string, remote: string, args: string[], rejected: string): void {
	try {
		git(root, ["push", "--porcelain", remote, ...args]);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		const { stdout, stderr } = error;
		// --porcelain reports each ref on stdout: `!` and `[rejected]` for a ref that is not as expected.
		if (/^!\t.*\t\[rejected\]/m.test(stdout)) throw new Refusal(rejected);
		// stderr may hold only the remote's chatter, so add each refused ref's reason from stdout.
		const refused = stdout.split("\n").filter((line) => line.startsWith("!"));
		const detail = [stderr.trim(), ...refused].filter((line) => line !== "").join("\n");
		throw new Error(`git push to ${remote} failed: ${detail}`);
	}
}

/** Whether a git command exits zero. */
function succeeds(root: string, args: string[]): boolean {
	try {
		git(root, args);
		return true;
	} catch {
		return false;
	}
}
