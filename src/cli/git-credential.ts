// Git signed in to the repositories a Kixel Quest hosts, the way `gh auth setup-git` signs it in to GitHub: `quest
// login` points the user's global git config at `quest git-credential` for that Kixel Quest's URL alone, and the helper
// answers with the token `login.json` holds for it, read on every call, so signing in again rotates it in place.
import { spawnSync } from "node:child_process";

import { discoveryEnv } from "./git";
import { notSignedIn, tokenFor } from "./tokens";

/** The helper git runs, found on PATH so an upgrade through mise or Nix keeps it working. */
export const HELPER = "!quest git-credential";

/**
 * The global git config key `quest login` writes for `url`. Git matches `<url>/` to the same requests as `<url>`, but
 * it is a key of quest's own, so signing out removes it whole and never touches a helper the person listed for `<url>`.
 */
export const helperKey = (url: string) => `credential.${url}/.helper`;

/**
 * Point git's credentials for `url` at quest alone: an empty helper masks any listed before it, such as `osxkeychain`,
 * for that URL only, without deleting them. Returns the entries, as `key = value` lines. A config already holding just
 * them, as one home-manager declares, is left unwritten.
 */
export function signInGit(url: string, env: NodeJS.ProcessEnv): string[] {
	const values = helpers(url, env);
	if (values.length === 2 && values[0] === "" && values[1] === HELPER) return entries(url);
	if (values.length > 0) config(url, env, ["--unset-all", helperKey(url)], "write");
	config(url, env, ["--add", helperKey(url), ""], "write");
	config(url, env, ["--add", helperKey(url), HELPER], "write");
	return entries(url);
}

/** Remove the entries `signInGit` writes for `url`, writing nothing when there are none. */
export function signOutGit(url: string, env: NodeJS.ProcessEnv): void {
	if (helpers(url, env).length > 0) config(url, env, ["--unset-all", helperKey(url)], "remove");
}

/** The values the global config holds under quest's key for `url`, in order. */
function helpers(url: string, env: NodeJS.ProcessEnv): string[] {
	// Git exits 1 when the key is absent.
	const listed = config(url, env, ["--null", "--get-all", helperKey(url)], "read", [1]);
	return listed === "" ? [] : listed.slice(0, -1).split("\0");
}

function config(url: string, env: NodeJS.ProcessEnv, args: string[], verb: string, allowed: number[] = []): string {
	const result = spawnSync("git", ["config", "--global", ...args], {
		encoding: "utf8",
		env: { ...discoveryEnv(env), GIT_TERMINAL_PROMPT: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout;
	if (allowed.includes(result.status ?? -1)) return "";
	// A read-only config, such as one home-manager links into place, gets the entries to declare there instead.
	throw new Error(
		`could not ${verb} git's global credential entries for ${url} (${entries(url).join(", ")}): ${result.stderr.trim()}`,
	);
}

const entries = (url: string) => [`${helperKey(url)} = ""`, `${helperKey(url)} = ${HELPER}`];

/**
 * Answer one git credential helper request: `get` with user `quest` and the token this host signed in to the request's
 * URL with, or, without one, `quit` so git fails rather than prompting, after `warn` names `quest login`. `store` and
 * `erase` do nothing, since `login.json` stays the only copy.
 */
export function credential(
	operation: string,
	input: string,
	env: NodeJS.ProcessEnv,
	warn: (line: string) => void,
): string {
	if (operation !== "get") return "";
	const request = new Map<string, string>();
	for (const line of input.split("\n")) {
		if (line === "") break;
		const at = line.indexOf("=");
		if (at > 0) request.set(line.slice(0, at), line.slice(at + 1));
	}
	const protocol = request.get("protocol");
	const host = request.get("host");
	if (!protocol || !host) return "";
	// As `kixelUrl` names it, so a remote written with its default port or an uppercase host finds the token.
	const url = URL.parse(`${protocol}://${host}`)?.origin;
	if (url === undefined || url === "null") return "";
	const token = tokenFor(url, env);
	if (token === null) {
		warn(notSignedIn(url));
		return "quit=1\n";
	}
	// A line break would let the token add fields of its own to the answer.
	if (/[\n\0]/.test(token)) {
		warn(`the token this host holds for ${url} is not one line; run \`quest login\``);
		return "quit=1\n";
	}
	return `username=quest\npassword=${token}\n`;
}
