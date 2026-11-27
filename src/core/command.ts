// What a session record keeps of a command it ran: each program's name and, where it takes one, its subcommand, such
// as `cd; cargo build; tail`. Arguments, assignments, redirections, and quoted text stay on the host, since a
// command line can carry a secret, such as an inline token, and records leave it. That is still enough for the
// mistake audit to tell a cheap command from a heavy one: `cargo check` from `cargo build`, `just check` from `just
// test`. A shell script is no easy grammar, so the parse below is not what keeps a secret on the host: a program
// counts only where it is a shell builtin or the host can run it, as the caller's `runs` decides, and a subcommand
// only where it is one of the fixed `VERBS`. Any other word read as one, such as a password a misread
// here-document or quote gave, becomes `?` or is left out, so a misreading costs the audit detail, never a secret.

/** The longest name a record keeps, in characters; names past it are left out. */
export const COMMAND_LIMIT = 200;

/** A program's name: a path's last part, short and of plain characters, or `?` for one written otherwise. */
const PROGRAM = /^(?:[A-Za-z0-9._+][A-Za-z0-9._+-]{0,31}|\?)$/;
/**
 * The subcommands a record keeps, a fixed list rather than any word's shape, so no data read as one leaves the host:
 * those of the build tools, package managers, and forge and service tools agents run, and the common names of
 * `just` and `make` recipes. Any other is left out, keeping only its program.
 */
const VERBS = new Set(
	`add all api apply audit auth bench blame branch build check checkout cherry-pick ci clean clippy clone commit
	compose config coverage create daemon delete deploy describe dev develop diff disable doc enable eval exec fetch
	flake fmt format gate gc generate get grep init install issue lint lock log logs merge metadata mod mv nextest
	outdated pr ps publish pull push rebase release remove repo reset restart restore rev-parse review rm run search serve
	shell show start stash status stop switch sync tag test tidy tree typecheck uninstall update upgrade usage vet
	watch workflow worktree x`.split(/\s+/),
);

/**
 * Programs whose first argument names what they do, kept as its subcommand. Any other program's first argument is
 * data, such as `cd`'s directory or `echo`'s text, and stays on the host.
 */
const SUBCOMMANDS = new Set([
	"apt",
	"brew",
	"bun",
	"bunx",
	"cargo",
	"deno",
	"dnf",
	"docker",
	"gh",
	"git",
	"go",
	"just",
	"kubectl",
	"make",
	"nix",
	"npm",
	"npx",
	"pnpm",
	"podman",
	"quest",
	"rustup",
	"systemctl",
	"uv",
	"yarn",
]);

/** Shell builtins, which name no file on PATH yet run as programs. */
const BUILTINS = new Set([
	".",
	":",
	"alias",
	"cd",
	"declare",
	"echo",
	"eval",
	"exit",
	"export",
	"local",
	"popd",
	"printf",
	"pushd",
	"pwd",
	"read",
	"return",
	"set",
	"shift",
	"source",
	"test",
	"trap",
	"type",
	"ulimit",
	"umask",
	"unset",
	"wait",
]);

/**
 * Whether a command's program word, a name or a path, runs on the host that ran it, a relative path resolved from
 * the directories the script changed to before it, in order, from where it started.
 */
export type Runs = (program: string, cd: string[]) => boolean;

/** Words that open a compound command or a wrapper of the next one, skipped to reach the program it runs. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);
/** Words that run the command after them, with flags and a number, such as a priority or timeout, between. */
const WRAPPERS = new Set(["env", "sudo", "time", "nice", "nohup", "exec", "command", "timeout", "xargs"]);
/** Words that open a construct naming no program, whose simple command is left out. */
const SKIPPED = new Set(["for", "case", "select", "function", "done", "fi", "esac", "in", "[", "[["]);

/** Whether `name` has the form `commandName` and `argvName` give, so a record can carry it. */
export function isCommandName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= COMMAND_LIMIT &&
		name.split("; ").every((part) => {
			const [program, sub, ...rest] = part.split(" ");
			return (
				rest.length === 0 &&
				PROGRAM.test(program!) &&
				(sub === undefined || (SUBCOMMANDS.has(program!) && VERBS.has(sub)))
			);
		})
	);
}

/** The programs a shell command line runs, in order and each once, as a record keeps them. */
export function commandName(script: string, runs: Runs): string {
	// Each literal `cd` the script ran so far, in order. A `cd` in a subshell or a failed one misleads this, which
	// at worst records a `?` for a program that did run.
	const cd: string[] = [];
	return join(
		words(script).map((command) => {
			if (command[0] === "cd" && command[1] !== undefined && command[1] !== "-" && !command[1].includes("$"))
				cd.push(command[1]);
			return simple(command, (program) => runs(program, cd));
		}),
	);
}

/** The program an argument vector runs, as a record keeps it, reading a shell's `-c` script as `commandName` does. */
export function argvName(argv: string[], runs: Runs): string {
	const run = (program: string) => runs(program, []);
	const program = argv[0]?.split(/[\\/]/).pop() ?? "";
	if (["sh", "bash", "zsh", "dash"].includes(program) && argv[1] === "-c" && argv[2] !== undefined) {
		return commandName(argv[2], runs);
	}
	return join([simple(argv, run)]);
}

function join(names: (string | null)[]): string {
	const seen: string[] = [];
	let length = 0;
	for (const name of names) {
		if (name === null || seen.includes(name)) continue;
		const added = (seen.length ? 2 : 0) + name.length;
		if (length + added > COMMAND_LIMIT) break;
		seen.push(name);
		length += added;
	}
	return seen.length ? seen.join("; ") : "?";
}

/** One simple command's program and subcommand, or null for one that names no program. */
function simple(command: string[], runs: (program: string) => boolean): string | null {
	let i = 0;
	const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
	for (;;) {
		const word = command[i];
		if (word === undefined) return null;
		if (SKIPPED.has(word)) return null;
		if (KEYWORDS.has(word) || assignment(word)) {
			i++;
			continue;
		}
		if (WRAPPERS.has(word.split(/[\\/]/).pop()!) && command[i + 1] !== undefined) {
			i++;
			while (command[i] !== undefined && /^(?:-.*|\d+[smhd]?|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(command[i]!)) i++;
			continue;
		}
		break;
	}
	const first = command[i]!;
	// A path's last part, by either separator, as Windows writes one, without a Windows program's extension.
	const base = first
		.split(/[\\/]/)
		.pop()!
		.replace(/\.(?:exe|cmd|bat|com)$/i, "");
	const path = /[\\/]/.test(first);
	const program = PROGRAM.test(base) && ((!path && BUILTINS.has(first)) || runs(first)) ? base : "?";
	const sub = SUBCOMMANDS.has(program) ? command[i + 1] : undefined;
	return sub !== undefined && VERBS.has(sub) ? `${program} ${sub}` : program;
}

/**
 * The simple commands of a shell script, each as its words with quotes removed. Redirections and their targets,
 * here-document bodies, and comments are dropped; text inside `$(…)` or backticks counts as commands of its own.
 * This reads common scripts, not every shell grammar: what it misreads becomes a `?` or a word's own name.
 */
function words(script: string): string[][] {
	const commands: string[][] = [];
	let current: string[] = [];
	let word: string | null = null;
	/** Pending here-documents' delimiters, and whether `<<-` lets tabs lead them. */
	const heredocs: { delimiter: string; tabs: boolean }[] = [];
	const endWord = () => {
		if (word !== null) current.push(word);
		word = null;
	};
	const endCommand = () => {
		endWord();
		if (current.length) commands.push(current);
		current = [];
	};
	let i = 0;
	const n = script.length;
	/**
	 * Read the command substitution whose text starts at `from` and ends at `close`'s index, as `script.indexOf`
	 * finds it, as commands of its own; the word it sits in goes on, its output standing as one character.
	 */
	const substitute = (from: number, close: number) => {
		const end = close === -1 ? n : close;
		commands.push(...words(script.slice(from, end)));
		word = (word ?? "") + "0";
		i = end + 1;
	};
	/** Read a quoted or plain word from `i` with no command structure, as a redirection's target. */
	const target = (): string => {
		while (script[i] === " " || script[i] === "\t") i++;
		let text = "";
		while (i < n && !/[\s;&|()<>`]/.test(script[i]!)) {
			const c = script[i]!;
			if (c === "'" || c === '"') {
				const close = script.indexOf(c, i + 1);
				const end = close === -1 ? n : close;
				text += script.slice(i + 1, end);
				i = end + 1;
			} else if (c === "\\") {
				text += script[i + 1] ?? "";
				i += 2;
			} else {
				text += c;
				i++;
			}
		}
		return text;
	};
	while (i < n) {
		const c = script[i]!;
		if (c === "\n") {
			endCommand();
			i++;
			// A here-document's body runs to the line that is its delimiter alone.
			while (heredocs.length && i < n) {
				const eol = script.indexOf("\n", i);
				const line = script.slice(i, eol === -1 ? n : eol);
				i = eol === -1 ? n : eol + 1;
				const { delimiter, tabs } = heredocs[0]!;
				if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) heredocs.shift();
			}
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === "#" && word === null) {
			while (i < n && script[i] !== "\n") i++;
		} else if (c === "\\") {
			if (script[i + 1] === "\n") i += 2;
			else {
				word = (word ?? "") + (script[i + 1] ?? "");
				i += 2;
			}
		} else if (c === "'") {
			const close = script.indexOf("'", i + 1);
			const end = close === -1 ? n : close;
			word = (word ?? "") + script.slice(i + 1, end);
			i = end + 1;
		} else if (c === '"') {
			// Literal text stays data; a substitution inside runs commands.
			word ??= "";
			i++;
			while (i < n && script[i] !== '"') {
				if (script[i] === "$" && script[i + 1] === "(" && script[i + 2] !== "(")
					substitute(i + 2, closing(script, i + 2));
				else if (script[i] === "`") substitute(i + 1, backtick(script, i + 1));
				else {
					if (script[i] === "\\" && i + 1 < n) i++;
					word += script[i];
					i++;
				}
			}
			i++;
		} else if (c === "<" || c === ">" || (c === "&" && script[i + 1] === ">")) {
			// A redirection: a file descriptor before it, its operator, and its target are no part of the command.
			if (word !== null && /^\d+$/.test(word)) word = null;
			endWord();
			let op = "";
			while (i < n && /[<>&|-]/.test(script[i]!) && op.length < 3) op += script[i++];
			if (op === "<<<") target();
			else if (op.startsWith("<<")) heredocs.push({ tabs: op === "<<-", delimiter: target() });
			else if (op.endsWith("&") && /\d|-/.test(script[i] ?? "")) {
				while (/[\d-]/.test(script[i] ?? "")) i++;
			} else target();
		} else if (c === "$" && script.startsWith("((", i + 1)) {
			// Arithmetic runs no program.
			const close = script.indexOf("))", i + 3);
			word = (word ?? "") + "0";
			i = close === -1 ? n : close + 2;
		} else if (c === "$" && script[i + 1] === "(") {
			substitute(i + 2, closing(script, i + 2));
		} else if (c === "`") {
			substitute(i + 1, backtick(script, i + 1));
		} else if (";&|()".includes(c)) {
			endCommand();
			i++;
		} else {
			word = (word ?? "") + c;
			i++;
		}
	}
	endCommand();
	return commands;
}

/**
 * The index of the `)` closing the substitution whose text starts at `from`, past nested ones, quotes, comments, and
 * here-document bodies, where a parenthesis is data; or -1.
 */
function closing(script: string, from: number): number {
	let depth = 1;
	const heredocs: { delimiter: string; tabs: boolean }[] = [];
	for (let i = from; i < script.length; i++) {
		const c = script[i]!;
		const wordStart = i === from || /[\s;&|()]/.test(script[i - 1]!);
		if (c === "\\") i++;
		else if (c === "'") {
			const close = script.indexOf("'", i + 1);
			if (close === -1) return -1;
			i = close;
		} else if (c === '"') {
			for (i++; i < script.length && script[i] !== '"'; i++) {
				if (script[i] === "\\") i++;
				else if (script[i] === "$" && script[i + 1] === "(") {
					i = closing(script, i + 2);
					if (i === -1) return -1;
				}
			}
		} else if (c === "#" && wordStart) {
			while (i + 1 < script.length && script[i + 1] !== "\n") i++;
		} else if (script.startsWith("<<<", i)) {
			// A here-string, whose word follows on its line, opens no here-document.
			i += 2;
		} else if (c === "<" && script.startsWith("<<", i)) {
			const tabs = script[i + 2] === "-";
			const match = /^[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(script.slice(i + (tabs ? 3 : 2)));
			if (match) {
				heredocs.push({ delimiter: (match[1] ?? match[2] ?? match[3]!).replace(/\\/g, ""), tabs });
				i += (tabs ? 3 : 2) + match[0].length - 1;
			}
		} else if (c === "\n" && heredocs.length) {
			// Skip each pending body, up to and including its delimiter's line.
			let at = i + 1;
			while (heredocs.length && at < script.length) {
				const eol = script.indexOf("\n", at);
				const line = script.slice(at, eol === -1 ? script.length : eol);
				at = eol === -1 ? script.length : eol + 1;
				const { delimiter, tabs } = heredocs[0]!;
				if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) heredocs.shift();
			}
			if (heredocs.length) return -1;
			i = at - 1;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

/** The index of the backtick closing the substitution whose text starts at `from`, or -1. */
function backtick(script: string, from: number): number {
	for (let i = from; i < script.length; i++) {
		if (script[i] === "\\") i++;
		else if (script[i] === "`") return i;
	}
	return -1;
}
