// Quests a PR adds that another open PR also adds, so a follow-up some other PR already owns is
// caught before a pick round asks about it.
import { type Duplicate, type PullRequest, isQuest, parse } from "../core";
import { type GitHubReader, object } from "./client";
import { openFiles } from "./files";

/** An open PR's added quest files, each with its title, or null when it has none. */
export interface Added {
	number: number;
	url: string;
	quests: { path: string; title: string | null }[];
}

/** Blobs read per title query. */
const BATCH = 100;

/** A file under a `quest/` directory, at the root or in a subdirectory holding a tree, that is a quest document. */
const questFile = (path: string) => /(?:^|\/)quest\/./.test(path) && isQuest(path);

/** A title compared without its size, case, or spacing, which agents vary for the same work. */
export function titleKey(title: string): string {
	return title
		.replace(/^\[[^\]]*\]\s*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Each quest `self` adds that another of `pulls` adds at the same path or with the same title. */
export function duplicates(self: number, pulls: Added[]): Duplicate[] {
	const own = pulls.find((pull) => pull.number === self);
	if (own === undefined) return [];
	const found: Duplicate[] = [];
	for (const quest of own.quests) {
		const key = quest.title === null ? null : titleKey(quest.title);
		for (const pull of pulls) {
			if (pull.number === self) continue;
			for (const other of pull.quests)
				if (
					other.path === quest.path ||
					(key !== "" && key !== null && other.title !== null && titleKey(other.title) === key)
				)
					found.push({ path: quest.path, url: pull.url, other: other.path });
		}
	}
	return found;
}

/**
 * The quests `pr` adds that another open PR in its repository also adds. Reads every open PR's files, then the titles of their quests at each PR's head, only when `pr` adds a quest.
 */
export async function duplicateQuests(github: GitHubReader, pr: PullRequest): Promise<Duplicate[]> {
	const pulls = (await openFiles(github, pr)).map(({ number, url, head, files }) => ({
		number,
		url,
		head,
		paths: files.filter((file) => file.added && questFile(file.path)).map((file) => file.path),
	}));
	const own = pulls.find((pull) => pull.number === pr.number);
	if (own === undefined || own.paths.length === 0) return [];
	const blobs = pulls.flatMap((pull) => pull.paths.map((path) => `${pull.head}:${path}`));
	const titles = new Map<string, string | null>();
	for (let start = 0; start < blobs.length; start += BATCH) {
		const batch = blobs.slice(start, start + BATCH);
		const query =
			`query($owner: String!, $repo: String!, ${batch.map((_, i) => `$e${i}: String!`).join(", ")}) { repository(owner: $owner, name: $repo) { ` +
			batch.map((_, i) => `f${i}: object(expression: $e${i}) { ... on Blob { text } }`).join(" ") +
			" } }";
		const data = await github.graphql(query, {
			owner: pr.owner,
			repo: pr.repo,
			...Object.fromEntries(batch.map((blob, i) => [`e${i}`, blob])),
		});
		const repository = object(data.repository);
		batch.forEach((blob, i) => {
			const node = repository[`f${i}`];
			const text = node === null || node === undefined ? null : object(node).text;
			const path = blob.slice(blob.indexOf(":") + 1);
			titles.set(blob, typeof text === "string" ? (parse(path, text).title?.text ?? null) : null);
		});
	}
	return duplicates(
		pr.number,
		pulls.map((pull) => ({
			number: pull.number,
			url: pull.url,
			quests: pull.paths.map((path) => ({ path, title: titles.get(`${pull.head}:${path}`) ?? null })),
		})),
	);
}
