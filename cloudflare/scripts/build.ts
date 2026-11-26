// Build the Worker's static assets into build/public (ignored by Git): the theme
// from design/theme/, the theme's two open-licensed fonts, the site CSS, the page script, the web app manifest, and
// the service worker stamped with this build's commit, so a deploy replaces the
// cached shell. Wrangler runs this before dev and deploy; check and test run it first.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The font files each @fontsource package gives the site; src/site.css declares them. */
export const FONTS: Record<string, string[]> = {
	"barlow-condensed": ["barlow-condensed-latin-600-normal.woff2", "barlow-condensed-latin-700-normal.woff2"],
	inter: ["inter-latin-400-normal.woff2", "inter-latin-600-normal.woff2"],
};

const worker = join(import.meta.dirname, "..");
const root = join(worker, "..");
const out = join(worker, "build", "public");

// A checkout always has a commit; a dirty one gets a timestamp so each build differs.
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
const version = dirty ? `${commit}-${Date.now()}` : commit;

rmSync(join(worker, "build"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "design", "theme"), join(out, "theme"), { recursive: true });
// design/theme.md's fonts, served from this site so pages render in them offline and
// without asking a third party: the Latin subset of each weight the theme uses, with its licence.
const fonts = join(out, "fonts");
mkdirSync(fonts);
for (const [pkg, files] of Object.entries(FONTS)) {
	const dir = join(root, "node_modules", "@fontsource", pkg);
	for (const file of files) cpSync(join(dir, "files", file), join(fonts, file));
	cpSync(join(dir, "LICENSE"), join(fonts, `${pkg}-OFL.txt`));
}
for (const file of ["site.css", "app.js", "manifest.webmanifest"]) cpSync(join(worker, "src", file), join(out, file));
const sw = readFileSync(join(worker, "src", "sw.js"), "utf8");
if (!sw.includes("__VERSION__")) throw new Error("src/sw.js lost its __VERSION__ placeholder");
writeFileSync(join(out, "sw.js"), sw.replace("__VERSION__", version));
