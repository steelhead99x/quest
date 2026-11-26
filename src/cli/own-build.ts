// A PR's code must not judge or land the PR: the source run inside a checkout is that PR's own build.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { git } from "./git";

/** Why a source run records no review, which the report names beside the round. */
export const OWN_REVIEW =
	"this quest runs from the source of the checkout it judges; rerun with an installed quest for the record that counts";

/** Why a source run lands nothing. */
export const OWN_MERGE = "this quest runs from the source of the checkout it lands; rerun with an installed quest";

/**
 * The top level of each checkout holding one of the `entries` the running quest executes from, as `bun src/cli/bin.ts`
 * or a `dist/quest.js` built there does; an installed bundle or binary lives outside every checkout. Without
 * entries, as under test, nothing runs from a checkout.
 */
function checkouts(entries: string[] | undefined): string[] {
	const tops: string[] = [];
	for (const entry of entries ?? []) {
		try {
			tops.push(realpathSync(git(dirname(realpathSync(entry)), ["rev-parse", "--show-toplevel"])));
		} catch {
			// A path outside any checkout, or inside a compiled binary's virtual file system.
		}
	}
	return tops;
}

/** Whether quest runs from the checkout of `root`, the one it would judge. */
export function runsFromCheckout(root: string, entries: string[] | undefined): boolean {
	let judged: string;
	try {
		judged = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
	} catch {
		// Not a checkout, so the command fails on its own terms.
		return false;
	}
	return checkouts(entries).includes(judged);
}

/** Whether quest runs from a checkout whose `HEAD` holds the commit `head`, so it is built from that PR's own code. */
export function runsFromHead(head: string, entries: string[] | undefined): boolean {
	return checkouts(entries).some((top) => {
		try {
			git(top, ["merge-base", "--is-ancestor", head, "HEAD"]);
			return true;
		} catch {
			return false;
		}
	});
}
