// The repositories a signed-in person can open: those the App is installed on
// that their token can read, grouped by the account that installed it.

import type { GitHub } from "./client.ts";

/** The most installations and repositories per installation one page lists. */
export const MAX_INSTALLATIONS = 10;
export const PER_PAGE = 100;

/** One account's installation and the repositories it shares with the person. */
export interface Installation {
	account: string;
	repositories: { owner: string; name: string; private: boolean }[];
	/** More repositories exist than one page lists. */
	more: boolean;
}

/** What the home page lists. */
export interface Repositories {
	installations: Installation[];
	/** More installations exist than one page lists. */
	more: boolean;
}

type Installations = { total_count: number; installations: { id: number; account: { login: string } | null }[] };
type Listed = {
	total_count: number;
	repositories: { name: string; private: boolean; owner: { login: string } }[];
};

/** The person's installations and their repositories. */
export async function repositories(github: GitHub): Promise<Repositories> {
	const found = await github.get<Installations>(`/user/installations?per_page=${MAX_INSTALLATIONS}`);
	if (!Array.isArray(found?.installations)) throw new Error("GitHub listed no installations array");
	const installations: Installation[] = [];
	for (const i of found.installations.slice(0, MAX_INSTALLATIONS)) {
		if (!Number.isSafeInteger(i.id)) throw new Error("GitHub listed an installation without an id");
		const listed = await github.get<Listed>(`/user/installations/${i.id}/repositories?per_page=${PER_PAGE}`);
		if (!Array.isArray(listed?.repositories)) throw new Error("GitHub listed no repositories array");
		installations.push({
			account: i.account?.login ?? "unknown",
			repositories: listed.repositories
				.slice(0, PER_PAGE)
				.map((r) => ({ owner: r.owner.login, name: r.name, private: r.private === true }))
				.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`)),
			more: listed.total_count > PER_PAGE,
		});
	}
	return { installations, more: found.total_count > MAX_INSTALLATIONS };
}
