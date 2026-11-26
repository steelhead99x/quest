// Build the Worker's static assets into build/public (ignored by Git): the theme
// from design/theme/, the site's open-licensed fonts, the site CSS, the page script, the web app manifest, and
// the service worker stamped with this build's commit, so a deploy replaces the
// cached shell. Wrangler runs this before dev and deploy; check and test run it first.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The font files each @fontsource package gives the site; src/site.css declares them.
 * Atkinson Hyperlegible Next and Mono, one family chosen for reading on a phone: it
 * tells I, l, and 1 and 0 and O apart, which matters in PR numbers, hashes, and paths.
 */
export const FONTS: Record<string, string[]> = {
	"@fontsource-variable/atkinson-hyperlegible-next": [
		"atkinson-hyperlegible-next-latin-wght-normal.woff2",
		"atkinson-hyperlegible-next-latin-wght-italic.woff2",
	],
	"@fontsource-variable/atkinson-hyperlegible-mono": ["atkinson-hyperlegible-mono-latin-wght-normal.woff2"],
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
// The site's fonts, served from this site so pages render in them offline and without
// asking a third party: the Latin subset of each face, with its licence.
const fonts = join(out, "fonts");
mkdirSync(fonts);
for (const [pkg, files] of Object.entries(FONTS)) {
	const dir = join(root, "node_modules", pkg);
	for (const file of files) cpSync(join(dir, "files", file), join(fonts, file));
	cpSync(join(dir, "LICENSE"), join(fonts, `${pkg.split("/")[1]}-OFL.txt`));
}
// The site's social image (brand/README.md).
cpSync(join(root, "design", "theme", "og.png"), join(out, "og.png"));
for (const file of ["site.css", "app.js", "manifest.webmanifest"]) cpSync(join(worker, "src", file), join(out, file));
const sw = readFileSync(join(worker, "src", "sw.js"), "utf8");
if (!sw.includes("__VERSION__")) throw new Error("src/sw.js lost its __VERSION__ placeholder");
writeFileSync(join(out, "sw.js"), sw.replace("__VERSION__", version));
