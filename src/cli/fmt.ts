// `quest fmt`: format the repository with its quest.toml's `[tasks.fmt]`, or else with the treefmt that
// `quest.lib.mkFlake` puts in its dev shell, run directly inside that shell so a format costs no Nix evaluation.
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";

import { MANIFEST_FILE } from "../core";
import { git } from "./git";
import { requireProgram, which } from "./program";
import { inDevShell, nativeOs, rootManifest } from "./run";

/** The task in quest.toml that replaces treefmt. */
const FMT_TASK = "fmt";

/** Format the repository holding `root`, passing `args` on, and return the formatter's exit status. */
export function fmt(root: string, args: string[], env: NodeJS.ProcessEnv): number {
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const task = rootManifest(top)?.tasks.find((each) => each.name === FMT_TASK) ?? null;
	if (task !== null && !task.os.includes(nativeOs()))
		throw new Error(`task ${FMT_TASK} runs only on ${task.os.join(", ")}`);
	// The task's script gets `args` as $1 onward.
	const [program, ...rest] =
		task === null ? ["treefmt", ...args] : ["bash", "-eo", "pipefail", "-c", task.run, "quest-fmt", ...args];
	const variables = Object.entries(task?.environment ?? {});
	let argv: string[];
	let childEnv = env;
	if ((task?.nix ?? true) && !inDevShell(env, top)) {
		if (!lstatSync(join(top, "flake.nix"), { throwIfNoEntry: false })?.isFile())
			throw new Error(
				task === null
					? `quest fmt runs treefmt in the repository's Nix dev shell, but ${top} has no flake.nix; declare [tasks.${FMT_TASK}] in ${MANIFEST_FILE} to format without it`
					: `${MANIFEST_FILE}: ${FMT_TASK} runs in the Nix dev shell, but ${top} has no flake.nix; set nix = false on it to run without Nix`,
			);
		// The environment applies inside the dev shell, as `quest run` sets it.
		const launch = variables.length === 0 ? [] : ["env", ...variables.map(([name, value]) => `${name}=${value}`)];
		argv = [requireProgram("nix", env), "develop", top, "--command", ...launch, program!, ...rest];
	} else {
		if (task === null && which("treefmt", env) === undefined)
			throw new Error(
				`no treefmt on PATH in this repository's dev shell; build it with quest.lib.mkFlake, or declare [tasks.${FMT_TASK}] in ${MANIFEST_FILE}`,
			);
		argv = [requireProgram(program!, env), ...rest];
		childEnv = { ...env, ...Object.fromEntries(variables) };
	}
	// treefmt finds the root itself and resolves paths from where it runs; the task runs from the root, as in quest run.
	const cwd = task === null ? resolve(root) : top;
	const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: childEnv, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal !== null) return 128 + constants.signals[result.signal];
	return result.status ?? 1;
}
