// Snapshot this checkout for the demo: its quest tree and workflow files, so
// the demo's stand-in GitHub serves real plans. Writes demo/snapshot.gen.js (ignored by Git), a module
// rather than JSON, so Wrangler and the Workers test runner both load it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isQuest } from "../../src/core/index.ts";

const worker = join(import.meta.dirname, "..");
const root = join(worker, "..");

function files(dir: string, keep: (name: string) => boolean): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (keep(name)) out.push({ path: relative(root, p), text: readFileSync(p, "utf8") });
		}
	};
	walk(join(root, dir));
	return out;
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(
	join(worker, "demo", "snapshot.gen.js"),
	"export default " +
		JSON.stringify({
			commit,
			quests: files("quest", isQuest),
			workflows: files(".github/workflows", (n) => /\.ya?ml$/.test(n)),
		}) +
		";\n",
);
