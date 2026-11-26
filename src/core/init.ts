// `quest init`'s file plan: which files installing Quest writes or removes in
// a repository, computed from what the repository holds without writing any.
//
// The plan touches only skill stubs (writing missing or outdated ones and
// removing those of retired skills), one reference line in the root agent
// instructions, one `.gitattributes` line, and `quest/README.md` when missing.
// A second plan (`planAudits`) adds a stub per shipped audit no quest names
// and the root does not skip, with the milestone it goes in. It never edits a
// quest, so a planted stub is the repository's from then on.
// It writes no Claude Code hooks: Quest's hooks are a user-level opt-in
// (`quest setup`), since a repository's settings would force them on every
// contributor.

import { AUDITS, type Audit, covered } from "./audit";
import { type Doc, has, holds, isQuest, parse } from "./doc";

/** Installed skills carry this prefix so they don't collide with a repository's own. */
export const PREFIX = "quest-";

/**
 * Marks Quest's line in the root agent instructions, so a repository can
 * reword the rest of it without init adding another.
 */
export const REFERENCE_MARKER = "Quests: ";

/**
 * Appended to the root agent instructions when Quest is installed. A session
 * whose `quest setup` hook already printed the rules skips the command.
 */
export const REFERENCE_LINE =
	"Quests: before any work, run `quest context` and follow it, or read https://github.com/kixel-ai/quest/blob/main/docs/context.md where `quest` is not installed, unless this session already holds its rules.";

/**
 * The skill directories Claude Code and other agents (Codex) read, each with
 * its own stub; new installs use real directories.
 */
export const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;

/** One of `SKILL_DIRS`. */
export type SkillDir = (typeof SKILL_DIRS)[number];

/** The directory whose stub works for every agent, so a directory both read through a link gets it. */
const PORTABLE: SkillDir = ".agents/skills";

/** Routes quest files through the `quest` merge driver; uninstall removes lines starting with it. */
export const ATTRIBUTES_LINE = "quest/** merge=quest";

/** The quest tree's root, with the project's goal or a placeholder for it. */
export function questReadme(goal?: string): string {
	return `# Quests\n\n## Goal\n\n${goal?.trim() || "What this project is working toward."}\n`;
}

/** What sits at a path: a directory, a regular file, a symbolic link, or anything else. */
export type Kind = "dir" | "file" | "symlink" | "other";

/**
 * A repository's files as the plan reads them. Paths are relative to the
 * repository root and joined with `/`. Reads may throw an `InitRefused`
 * naming a path the caller cannot inspect.
 */
export interface Checkout {
	/** What sits at `path` without following a final symlink, or null when nothing does. */
	lstat(path: string): Kind | null;
	/** What `path` resolves to, following symlinks, or null when it, or a link's target, is missing. */
	stat(path: string): Exclude<Kind, "symlink"> | null;
	/** The text of the file at `path`, following symlinks. */
	read(path: string): string;
	/** The entry names in the directory at `path`. */
	list(path: string): string[];
	/** Where `path` resolves to, so two names for one directory compare equal; a missing path is itself. */
	real(path: string): string;
}

/** One skill as a repository installs it: its directory name and the `SKILL.md` each skill directory gets. */
export interface Stub {
	installed: string;
	stubs: Readonly<Record<SkillDir, string>>;
}

/** One file the plan sets to `content`, or, with null content, a retired stub it deletes along with its directory once empty. */
export interface InitChange {
	path: string;
	content: string | null;
}

/** Init cannot install because of what sits at `path`; the repository needs a person's judgement. */
export class InitRefused extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "InitRefused";
	}
}

function refuse(path: string, why: string): never {
	throw new InitRefused(path, `${path} ${why}; remove or rename it before running \`quest init\``);
}

/**
 * The changes installing Quest makes in `repo`, in order, with `stubs` as the
 * skills to install and `goal` as a new `quest/README.md`'s Goal. Every
 * conflict throws an `InitRefused` before any change is returned, so a
 * refused init leaves the repository as it was. An empty plan means Quest is
 * already installed.
 */
export function planInit(repo: Checkout, stubs: readonly Stub[], options: { goal?: string } = {}): InitChange[] {
	const dirs = skillDirs(repo);
	const written = dirs.flatMap(({ skills, shared }) =>
		stubs.flatMap((skill): InitChange[] => {
			const dir = `${skills}/${skill.installed}`;
			const path = `${dir}/SKILL.md`;
			const stub = skill.stubs[shared || sharedSkill(repo, skill.installed) ? PORTABLE : skills];
			checkPath(repo, path, "file");
			if (repo.stat(path) === "file") {
				if (!isStub(repo, path, skill.installed)) refuse(path, "is not a Quest stub");
				// An older version's stub is rewritten in place, keeping its newlines; Quest writes no links, so it leaves linked ones.
				const content = repo.read(path);
				if (content.replaceAll("\r\n", "\n") === stub) return [];
				if (repo.lstat(dir) !== "dir" || repo.lstat(path) !== "file") return [];
				return [{ path, content: stub.replaceAll("\n", newline(content)) }];
			} else if (repo.lstat(dir) !== null) {
				throw new InitRefused(
					dir,
					`${dir} exists without SKILL.md; remove or rename it before running \`quest init\``,
				);
			}
			return [{ path, content: stub }];
		}),
	);
	const current = new Set(stubs.map((skill) => skill.installed));
	const retired = dirs.flatMap(({ skills }) =>
		installedStubs(repo, skills).filter((dir) => !current.has(dir.slice(dir.lastIndexOf("/") + 1))),
	);
	const readme = "quest/README.md";
	checkPath(repo, readme, "file");
	const instructions = ["AGENTS.md", "CLAUDE.md"].find((name) => repo.stat(name) === "file") ?? "AGENTS.md";
	checkPath(repo, instructions, "file");
	checkPath(repo, ".gitattributes", "file");

	const changes: InitChange[] = [...written, ...retired.map((dir) => ({ path: `${dir}/SKILL.md`, content: null }))];
	if (repo.lstat(readme) === null) changes.push({ path: readme, content: questReadme(options.goal) });
	for (const [path, marker, line] of [
		[instructions, REFERENCE_MARKER, REFERENCE_LINE],
		[".gitattributes", ATTRIBUTES_LINE, ATTRIBUTES_LINE],
	] as const) {
		const content = appendLine(repo.stat(path) === "file" ? repo.read(path) : "", marker, line);
		if (content !== null) changes.push({ path, content });
	}
	return changes;
}

/** A milestone's README, capturing its number. */
const MILESTONE = /^quest\/m(0|[1-9]\d*)\/README\.md$/;

/**
 * The stubs for every shipped audit no quest names and the root README does
 * not skip, with any milestone they need. Each first run waits for the work
 * under way: it goes in m(N+1), creating it when missing, with `Required` on
 * the lowest open milestone mN. Where no milestone is open, nothing is under
 * way to wait for, and a link to a finished milestone would fail `quest
 * check`, so the stubs go in m(N+1) after the lowest milestone, m0 created
 * when there is none, and are ready at once.
 */
export function planAudits(repo: Checkout): InitChange[] {
	const { paths, docs } = questDocs(repo);
	const done = covered(docs, "quest/README.md");
	const missing = AUDITS.filter((audit) => !done.has(audit.name));
	if (missing.length === 0) return [];

	const milestones = new Map<number, Doc>();
	for (const doc of docs) {
		const match = MILESTONE.exec(doc.path);
		if (match) milestones.set(Number(match[1]), doc);
	}
	const open = [...milestones]
		.filter(([, milestone]) => has(milestone, "Required") || paths.some((path) => holds(milestone.path, path)))
		.map(([number]) => number);
	const after = open.length > 0 ? Math.min(...open) : milestones.size > 0 ? Math.min(...milestones.keys()) : 0;
	const next = after + 1;

	const changes: InitChange[] = [];
	for (const [number, content] of [
		[after, milestoneReadme(after)],
		[next, milestoneReadme(next)],
	] as const) {
		const path = `quest/m${number}/README.md`;
		if (milestones.has(number)) continue;
		checkPath(repo, path, "file");
		if (repo.lstat(path) !== null) refuse(path, "is not a quest document");
		// Its branch, `quest/mN`, cannot exist beside the milestone's.
		if (repo.lstat(`quest/m${number}.md`) !== null)
			refuse(`quest/m${number}.md`, `is in the way of milestone m${number}, which an audit's stub needs`);
		changes.push({ path, content });
	}
	for (const audit of missing) {
		const path = `quest/m${next}/audit-${audit.name}.md`;
		checkPath(repo, path, "file");
		// No quest names the audit, so whatever sits here is other work, and its branch would nest a stub's.
		for (const taken of [path, path.slice(0, -".md".length)])
			if (repo.lstat(taken) !== null)
				throw new InitRefused(
					taken,
					`${taken} is in the way of the \`${audit.name}\` audit's stub, which no quest names; move it, or, if the maintainer declines the audit, list \`${audit.name}\` under \`## Skipped audits\` in \`quest/README.md\`, before running \`quest init\``,
				);
		changes.push({ path, content: auditStub(audit, open.length > 0 ? after : null) });
	}
	return changes;
}

/** A milestone README `quest init` creates for a stub to sit in, with a one-line Goal. */
function milestoneReadme(number: number): string {
	return number === 0
		? "# Now\n\n## Goal\n\nThe work under way now.\n"
		: `# After m${number - 1}\n\n## Goal\n\nThe work that follows m${number - 1}.\n`;
}

/** A planted audit stub: the audit's title and name, a Goal pointing at its definition, and the milestone it waits for. */
function auditStub(audit: Audit, after: number | null): string {
	const required =
		after === null ? "" : `\n## Required\n\n- [m${after}](/quest/m${after}/README.md) - the audit runs after it\n`;
	return (
		`# ${audit.title}\n\n## Goal\n\nRun the \`${audit.name}\` audit: \`quest audit ${audit.name}\` prints what it ` +
		`checks, what each finding becomes, and how to plan its next run.\n\n## Audit\n\n- ${audit.name}\n${required}`
	);
}

/**
 * Every quest document's path under `quest/`, as `quest check` collects them (symlinked files are read,
 * symlinked directories skipped), and the documents an audit plan reads: the milestone READMEs and any
 * whose text, without emphasis, code, and escape marks, holds either heading's name, so a decorated or
 * setext heading still counts. Parsing the rest would take a 500-document tree's hook from 0.1s to 0.5s.
 */
function questDocs(repo: Checkout): { paths: string[]; docs: Doc[] } {
	const paths: string[] = [];
	const docs: Doc[] = [];
	const walk = (dir: string) => {
		for (const name of repo.list(dir)) {
			const path = `${dir}/${name}`;
			if (repo.lstat(path) === "dir") walk(path);
			else if (isQuest(path) && repo.stat(path) === "file") {
				paths.push(path);
				const text = repo.read(path);
				const plain = text.replace(/[*_`\\]/g, "");
				if (MILESTONE.test(path) || plain.includes("Audit") || /Skipped\s+audits/.test(plain))
					docs.push(parse(path, text));
			}
		}
	};
	if (repo.stat("quest") === "dir") walk("quest");
	return { paths, docs };
}

/** Check an install destination and its parents before any writes, following valid symlinks. */
function checkPath(repo: Checkout, path: string, expected: "dir" | "file"): void {
	const slash = path.lastIndexOf("/");
	if (slash > 0) checkPath(repo, path.slice(0, slash), "dir");
	const found = repo.stat(path);
	if (found === null ? repo.lstat(path) === null : found === expected) return;
	refuse(path, `is not a ${expected === "dir" ? "directory" : "file"}`);
}

/**
 * Validate both destinations before writing. Existing links to one tree are
 * installed once, with the stub every agent can follow, marked `shared`.
 */
function skillDirs(repo: Checkout): { skills: SkillDir; shared: boolean }[] {
	const seen = new Map<string, { skills: SkillDir; shared: boolean }>();
	for (const skills of SKILL_DIRS) {
		checkPath(repo, skills, "dir");
		const destination = repo.stat(skills) === null ? skills : repo.real(skills);
		const earlier = seen.get(destination);
		if (earlier) earlier.shared = true;
		else seen.set(destination, { skills, shared: false });
	}
	return [...seen.values()];
}

/**
 * Whether every skill directory reads the skill installed as `installed`
 * from one file, through a link to the skill or to its `SKILL.md`, so it
 * needs the stub every agent can follow.
 */
function sharedSkill(repo: Checkout, installed: string): boolean {
	const files = SKILL_DIRS.map((skills) => `${skills}/${installed}/SKILL.md`);
	for (const file of files) checkPath(repo, file, "file");
	if (files.some((file) => repo.stat(file) !== "file")) return false;
	return new Set(files.map((file) => repo.real(file))).size === 1;
}

/**
 * Any version's stub: frontmatter naming the skill, then either the pointer
 * to `quest skill` or Claude Code's inline call of it. Descriptions and the
 * setup link change between versions, so only these shapes identify a file
 * Quest wrote. A pointer's frontmatter has only ever held `name` and
 * `description`, and an inline stub's also exactly the one `allowed-tools`
 * line its call needs, so any other field marks an edited stub. Each capture
 * names the skill.
 */
const STUBS = [
	/^---\nname: (\S+)\n(?:(?:name|description): .*\n)*---\n\nRun `quest skill (\S+)` and follow its output\.\nIf `quest` is not installed, follow \S+ first\.\n$/,
	/^---\nname: (\S+)\n(?:(?:name|description): .*\n)*allowed-tools: Bash\(quest skill (\S+)\) PowerShell\(quest skill (\S+)\)\n---\n\n!`quest skill (\S+); echo "[^"`\n]*"`\n$/,
];

/**
 * Whether `path` holds a Quest stub of any version for the skill installed as
 * `installed`. Git may check out unchanged stubs with CRLF in an adopting repository.
 */
function isStub(repo: Checkout, path: string, installed: string): boolean {
	const content = repo.read(path).replaceAll("\r\n", "\n");
	return STUBS.some((shape) => {
		const match = shape.exec(content);
		return (
			match !== null && match[1] === installed && match.slice(2).every((name) => `${PREFIX}${name}` === installed)
		);
	});
}

/**
 * The skill directories under `skills` that hold a Quest stub of any version,
 * including skills this version no longer ships. Quest writes neither links
 * nor other files there, so it skips symlinks.
 */
export function installedStubs(repo: Checkout, skills: string): string[] {
	if (repo.lstat(skills) === null) return [];
	return repo
		.list(skills)
		.filter((name) => name.startsWith(PREFIX))
		.map((name) => `${skills}/${name}`)
		.filter(
			(dir) =>
				repo.lstat(dir) === "dir" &&
				repo.lstat(`${dir}/SKILL.md`) === "file" &&
				isStub(repo, `${dir}/SKILL.md`, dir.slice(dir.lastIndexOf("/") + 1)),
		)
		.sort();
}

/** The line ending a file already uses. */
export function newline(content: string): string {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Lines without their terminators, as Markdown editors on any platform wrote them. */
export function lines(content: string): string[] {
	const out = content.split(/\r?\n/);
	if (out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * `content` with `line` appended, separated from existing content by a blank
 * line, or null when a line already starts with `marker`.
 */
function appendLine(content: string, marker: string, line: string): string | null {
	if (lines(content).some((l) => l.startsWith(marker))) return null;
	const eol = newline(content);
	if (content !== "") {
		if (!content.endsWith("\n")) content += eol;
		content += eol;
	}
	return `${content}${line}${eol}`;
}
