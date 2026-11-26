// The audit pack's definitions, bundled into the CLI like the skills. A
// repository's stub names one in its `## Audit` section, so improving a
// definition reaches every repository on its next run.

import { AUDITS } from "../core";
import running from "../../assets/audit.md";
import code from "../../assets/audits/code.md";
import cost from "../../assets/audits/cost.md";
import deps from "../../assets/audits/deps.md";
import docs from "../../assets/audits/docs.md";
import instructions from "../../assets/audits/instructions.md";
import tests from "../../assets/audits/tests.md";
import tree from "../../assets/audits/tree.md";

const DEFINITIONS: Readonly<Record<string, string>> = { code, cost, deps, docs, instructions, tests, tree };

/** What `quest audit <name>` prints: its definition, then how every audit runs and recurs; undefined for one quest does not ship. */
export function audit(name: string): string | undefined {
	const definition = AUDITS.some((a) => a.name === name) ? DEFINITIONS[name] : undefined;
	return definition === undefined ? undefined : `${definition.trim()}\n\n${running.trim()}\n`;
}

// The core's list decides what `quest check` accepts and `quest init` plants, so a definition it lacks, or one missing here, fails every command.
const names = AUDITS.map((a) => a.name);
for (const name of new Set([...names, ...Object.keys(DEFINITIONS)]))
	if (!names.includes(name) || !(name in DEFINITIONS))
		throw new Error(`audit ${name} needs both a definition and an entry in AUDITS`);
