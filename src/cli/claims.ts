// Finding where a checkout's claims live, through its git remotes, and reading them there as
// `src/github/claims.ts` decides them. Commands that must not disturb held work look here first,
// and `quest start` records a claim the same way, judging readiness by the upstream tree.
import { git } from "./git";
import { type Remote, readRemote, remoteHost, remoteRepository, requireRemote } from "./github";
import { type GitHubDependencies, GitHub, object, repositoryPath, string } from "../github/client";
import type { Claim, Forge, ForgeWrites, Holdings, OpenPull, Repository } from "../core";
import { questBranches } from "../github/claims";
import { landingCheck } from "./landed";
import { GitHubWrites } from "./writes";
import { type Snapshot, snapshot } from "./tree";

export interface ClaimDependencies {
	/** Called only when the remote is on GitHub, so other forges need no token. */
	github(): GitHubDependencies;
	/** The forge answering reads of a repository on GitHub, such as its claims and open PRs. */
	forge(repository: Repository): Promise<Forge>;
	/** Kixel Quest, for remotes on it; without it, no remote is. */
	kixel?: {
		/** The repository `url` on Kixel Quest names, or null for none. */
		hosted(url: string): Repository | null;
		/** Kixel Quest's backend for a repository it hosts, which both reads and writes there. */
		forge(repository: Repository): Forge & ForgeWrites;
	};
	warn(message: string): void;
}

/** The forge an upstream's PRs and claims live on, GitHub or Kixel Quest. */
export interface Hosting {
	/** Where PRs open and claims are checked. */
	repository: Repository;
	/** The repository the remote pushes to: `repository` itself, or a fork. */
	head: Repository;
	defaultBranch: string;
	/** Where this checkout's tree sits in the repository: empty at the top level, else a path ending in `/`. */
	prefix: string;
	/** The forge answering reads of `repository`, chosen on first use. */
	forge(): Promise<Forge>;
	/** The forge taking writes to `repository`, created on first use. */
	writes(): ForgeWrites;
	/** A link to `path` on the default branch, where the forge shows files. */
	link(path: string): string | null;
}

/**
 * Where claims live: the furthest repository up the remote's fork chain that
 * keeps quests, so a contributor's fork claims on the project it came from,
 * while a fork with its own quest tree claims on itself.
 */
export interface Upstream {
	/** The remote's name, or the upstream's URL when that is an ancestor; git reads upstream branches from it. */
	git: string;
	/** The URL the remote pushes to, where a claim branch is pushed. Read from git on first use. */
	readonly push: string;
	/** The forge PRs open on, or null off GitHub and Kixel Quest. */
	hosting: Hosting | null;
	/** `hosting` on GitHub, with its client for what only GitHub answers; null elsewhere. */
	github: (Hosting & { client: GitHub }) | null;
}

/**
 * The upstream of `remote`. On GitHub, it walks from the remote's repository
 * up to each parent whose default branch holds the quest tree's README, and
 * stops at the first parent without one; a failed lookup fails rather than
 * stops the walk. An ancestor is reached with the same URL scheme as the
 * remote. Off GitHub, the remote is its own upstream, and on Kixel Quest, which
 * keeps no forks, it is the repository there. The head repository is where the
 * remote pushes, which may be a fork even when it fetches from upstream.
 */
export async function upstream(root: string, remote: Remote, deps: ClaimDependencies): Promise<Upstream> {
	const kixel = deps.kixel;
	const source = remoteHost(remote, kixel ? (url) => kixel.hosted(url) : null);
	if (source?.forge !== "github") {
		const repository = source?.repository ?? null;
		let hosted: (Forge & ForgeWrites) | undefined;
		const forge = () => (hosted ??= kixel!.forge(repository!));
		return {
			git: remote.name,
			get push() {
				return remote.used().push;
			},
			hosting:
				repository === null
					? null
					: {
							repository,
							head: repository,
							defaultBranch: defaultBranch(root, remote.name),
							prefix: git(root, ["rev-parse", "--show-prefix"]),
							forge: async () => forge(),
							writes: forge,
							link: () => null,
						},
			github: null,
		};
	}

	const client = new GitHub(deps.github());
	const self = await repositoryInfo(client, source.repository);
	// Push somewhere other than the fetched repository, such as a fork, and that is the head; a push
	// URL off GitHub can open no PR, so it falls back to the fetched repository.
	const pushed = remoteRepository(remote, true).repository;
	const head =
		pushed === null || same(pushed, self.repository)
			? self.repository
			: (await repositoryInfo(client, pushed)).repository;
	// The README where this checkout's tree sits, which may be below the top level.
	const prefix = git(root, ["rev-parse", "--show-prefix"]);
	const up = await base(client, self, prefix);
	let forge: Promise<Forge> | undefined;
	let writes: ForgeWrites | undefined;
	const { owner, repo } = up.repository;
	const github = {
		client,
		repository: up.repository,
		head,
		defaultBranch: up.defaultBranch,
		prefix,
		forge: () => (forge ??= deps.forge(up.repository)),
		writes: () => (writes ??= new GitHubWrites(deps.github(), landingCheck(root))),
		link: (path: string) =>
			`https://github.com/${owner}/${repo}/blob/${up.defaultBranch}/${encodeURI(prefix + path)}`,
	};
	return {
		// Reach an ancestor the way the remote is reached, so the same credentials work.
		git: up === self ? remote.name : /^https:/.test(source.url) ? up.https : up.ssh,
		get push() {
			return remote.used().push;
		},
		hosting: github,
		github,
	};
}

/** The branch `remote`'s HEAD names, as `git ls-remote --symref` reports it. */
export function defaultBranch(root: string, remote: string): string {
	const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(git(root, ["ls-remote", "--symref", remote, "HEAD"]));
	if (match === null) throw new Error(`${remote} names no default branch`);
	return match[1]!;
}

type Info = Awaited<ReturnType<typeof repositoryInfo>>;

/** `self`, or the nearest fork ancestor whose default branch keeps the quest tree at `prefix`. */
async function base(client: GitHub, self: Info, prefix: string): Promise<Info> {
	let up = self;
	while (up.parent !== null && (await has(client, up.parent, `${prefix}quest/README.md`)))
		up = await repositoryInfo(client, up.parent);
	return up;
}

/** The repository a checkout of `repository`, whose tree sits at `prefix`, opens its PRs on, as `upstream` finds it. */
export async function baseRepository(client: GitHub, repository: Repository, prefix: string): Promise<Repository> {
	return (await base(client, await repositoryInfo(client, repository), prefix)).repository;
}

/** A repository as GitHub names it, its default branch and clone URLs, and its parent when it is a fork. */
async function repositoryInfo(
	client: GitHub,
	named: Repository,
): Promise<{ repository: Repository; defaultBranch: string; https: string; ssh: string; parent: Repository | null }> {
	const info = object(await (await client.request(repositoryPath(named))).json());
	const parent = info.fork === true && info.parent !== undefined && info.parent !== null ? object(info.parent) : null;
	return {
		repository: { owner: string(object(info.owner).login), repo: string(info.name) },
		defaultBranch: string(info.default_branch),
		https: string(info.clone_url),
		ssh: string(info.ssh_url),
		parent: parent === null ? null : { owner: string(object(parent.owner).login), repo: string(parent.name) },
	};
}

/** Whether `repository`'s default branch has `path`. Only a 404 says no; any other failure throws. */
async function has(client: GitHub, repository: Repository, path: string): Promise<boolean> {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	const response = await client.request(`${repositoryPath(repository)}/contents/${encoded}`, { allow: [404] });
	return response.status !== 404;
}

/** Whether two names are the same repository; GitHub ignores case. */
function same(a: Repository, b: Repository): boolean {
	return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/** The `quest/*` branches on `remote` (a name or URL), with their tips. Plain git, so it works with any forge. */
export function remoteBranches(root: string, remote: string): Map<string, string> {
	return questBranches(listRemote(root, remote, ["refs/heads/quest/*"]));
}

/** The refs on `remote` matching `patterns`, by name, with their tips. */
function listRemote(root: string, remote: string, patterns: string[]): Map<string, string> {
	const refs = new Map<string, string>();
	for (const line of git(root, ["ls-remote", remote, ...patterns]).split("\n")) {
		if (line === "") continue;
		const [sha, ref] = line.split("\t");
		refs.set(ref, sha);
	}
	return refs;
}

/**
 * Which of `branches` someone holds: pushed to `remote` or its upstream, or the
 * head of an open PR in either. Without the remote it warns and checks nothing;
 * off GitHub and Kixel Quest it checks branches only.
 */
export async function claims(
	root: string,
	remote: string,
	branches: string[],
	deps: ClaimDependencies,
): Promise<Claim[]> {
	const up = await reach(root, remote, deps);
	return up === null ? [] : (await held(root, up, branches)).claims;
}

/**
 * The upstream of `remote` for reading claims, warning when off GitHub and
 * Kixel Quest that only branches count. Without the remote it warns and returns `null`.
 */
export async function reach(root: string, name: string, deps: ClaimDependencies): Promise<Upstream | null> {
	const remote = readRemote(root, name);
	if (remote === null) {
		deps.warn(`no ${name} remote, so claims were not checked`);
		return null;
	}
	const up = await upstream(root, remote, deps);
	if (up.hosting === null)
		deps.warn(`${name} is not on GitHub or Kixel Quest, so only its branches were checked for claims`);
	return up;
}

/**
 * Which of `branches` someone holds, as the upstream's forge decides it. `tips` are the upstream's
 * `quest/*` branches, when already read; the fork's are read through git too. Off GitHub and Kixel
 * Quest, every branch pushed upstream holds its quest.
 */
export async function held(
	root: string,
	up: Upstream,
	branches: string[],
	tips: Map<string, string> = remoteBranches(root, up.git),
): Promise<Holdings> {
	if (up.hosting === null)
		return {
			claims: [...new Set(branches)]
				.sort()
				.filter((branch) => tips.has(branch))
				.map((branch) => ({ branch, url: null, pull: null })),
			landed: new Map(),
		};
	const { repository, head } = up.hosting;
	const forge = await up.hosting.forge();
	const sources = {
		upstream: { repository, tips },
		...(same(head, repository) ? {} : { fork: { repository: head, tips: remoteBranches(root, up.push) } }),
	};
	return (await forge.held(sources, branches)).value;
}

/**
 * The open drafts in the upstream of the remote `name`, from any head
 * repository. Reading them needs a forge, so without the remote, off GitHub
 * and Kixel Quest, or when the forge cannot be reached or refuses, it warns that they were
 * skipped and returns none, leaving the caller the quest tree.
 */
export async function openDrafts(root: string, name: string, deps: ClaimDependencies): Promise<OpenPull[]> {
	const remote = readRemote(root, name);
	if (remote === null) {
		deps.warn(`no ${name} remote, so draft PRs were skipped`);
		return [];
	}
	try {
		const up = await upstream(root, remote, deps);
		if (up.hosting === null) {
			deps.warn(`${name} is not on GitHub or Kixel Quest, so draft PRs were skipped`);
			return [];
		}
		const pulls = (await (await up.hosting.forge()).pulls(up.hosting.repository)).value;
		return pulls.filter((pull) => pull.draft).sort((a, b) => a.number - b.number);
	} catch (error) {
		deps.warn(`draft PRs were skipped: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** Where a claim lands: the remote, its upstream, and the upstream default branch's tip and quest tree. */
export interface Target extends UpstreamRefs {
	remote: string;
	up: Upstream;
	tree: Snapshot;
}

/** The target for claims pushed to `remote`, read from the fetched upstream default branch. */
export async function target(root: string, remote: string, deps: ClaimDependencies): Promise<Target> {
	const up = await upstream(root, requireRemote(root, remote), deps);
	const refs = upstreamRefs(root, up.git);
	return { remote, up, ...refs, tree: snapshot(root, refs.base, deps.warn) };
}

/** What the upstream holds, read with one `ls-remote`. */
export interface UpstreamRefs {
	/** The default branch's tip, fetched so it can be read and built on. */
	base: string;
	/** The `quest/*` branches, with their tips. */
	branches: Map<string, string>;
}

/** The refs of `remote` (a name or URL) that claims read. */
export function upstreamRefs(root: string, remote: string): UpstreamRefs {
	const refs = listRemote(root, remote, ["HEAD", "refs/heads/quest/*"]);
	const base = refs.get("HEAD");
	if (!base) throw new Error(`${remote} has no default branch`);
	ensure(root, remote, base);
	return { base, branches: questBranches(refs) };
}

/** Make `sha` from `remote` available locally. */
export function ensure(root: string, remote: string, sha: string): void {
	try {
		git(root, ["cat-file", "-e", `${sha}^{commit}`]);
	} catch {
		git(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, sha]);
	}
}
