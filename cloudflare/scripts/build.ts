// Build the Worker's static assets into build/public (ignored by Git): the theme
// from design/theme/, the site CSS, the page script, the web app manifest, and
// the service worker stamped with this build's commit, so a deploy replaces the
// cached shell. Wrangler runs this before dev and deploy; check and test run it first.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
for (const file of ["site.css", "app.js", "manifest.webmanifest"]) cpSync(join(worker, "src", file), join(out, file));
const sw = readFileSync(join(worker, "src", "sw.js"), "utf8");
if (!sw.includes("__VERSION__")) throw new Error("src/sw.js lost its __VERSION__ placeholder");
writeFileSync(join(out, "sw.js"), sw.replace("__VERSION__", version));
