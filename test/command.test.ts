import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import { expect, test } from "vitest";

import { COMMAND_LIMIT, argvName, commandName, isCommandName } from "../src/core";
import { runs } from "../src/cli/program";
import { tempDir } from "./fixture";

/** The programs a host in these tests can run, by name or path. */
const installed = new Set(
	"bun cargo cat curl date gh git just ls make node quest tail /usr/bin/time target/release/quest /bin/sh".split(" "),
);
const host = (program: string, cd: string[]) =>
	installed.has(program.includes("/") ? posix.join(...cd, program) : program);

test.each([
	["cargo build --release", "cargo build"],
	["cd src && cargo test -p foo 2>&1 | tail -20", "cd; cargo test; tail"],
	["GH_TOKEN=ghp_secret gh pr view 1", "gh pr"],
	["curl -H 'Authorization: Bearer abcdef' https://x", "curl"],
	['git commit -m "fix; rm stuff && more"', "git commit"],
	["echo hunter2 > /tmp/x; cat < /tmp/x", "echo; cat"],
	["cat > x <<'EOF'\nsecret body; rm -rf /\nEOF\njust check", "cat; just check"],
	["env -i FOO=1 timeout 30s nice -n 10 bun test", "bun test"],
	["/usr/bin/time ./target/release/quest gate just test", "quest gate"],
	["for f in a b; do just check; done", "just check"],
	["if [[ -f x ]]; then make all; fi", "make all"],
	["x=$(git rev-parse HEAD)", "git rev-parse"],
	["git log abc123def", "git log"],
	["echo hunter", "echo"],
	["$EDITOR file", "?"],
	["# just a comment", "?"],
	["just check && just check", "just check"],
	["printf '%s' $(date +%s) hunter2", "date; printf"],
	["printf %s `date` hunter2; ls", "date; printf; ls"],
	['output="$(cargo check)"; echo "$output"', "cargo check; echo"],
	['echo "a $(git log --format="%H (x)") b"', "git log; echo"],
	["cat <<'EOF'\n  EOF\nhunter2\nEOF\nls", "cat; ls"],
	["cat <<-EOF\n\thunter2\n\tEOF\nls", "cat; ls"],
	["printf '%s' $(cat <<'EOF'\n)\nhunter2\nEOF\n)", "cat; printf"],
	["x=$(ls # a ) comment\n)", "ls"],
	// A word misread as a program, or one the host cannot run, stays a `?`.
	["hunter2; gh pr view", "?; gh pr"],
	["./hunter2 x", "?"],
	['echo "$(cat <<< hi\n)" "hello; git password"', "cat; echo"],
	// A subcommand outside the fixed list is left out, as a password a misread quote would make one.
	["git password", "git"],
	["just my-recipe", "just"],
	['output="$(cat <<< foo\n)"; cargo check', "cat; cargo check"],
	["cd target && release/quest gate", "cd; quest gate"],
])("%j is kept as %j", (script, name) => {
	expect(commandName(script, host)).toBe(name);
	expect(isCommandName(name)).toBe(true);
});

test("an argument vector keeps its program and subcommand, reading a shell's script", () => {
	expect(argvName(["cargo", "build", "--release"], host)).toBe("cargo build");
	expect(argvName(["/bin/sh", "-c", "cd x && bun test secret"], host)).toBe("cd; bun test");
	expect(argvName(["node", "-e", "spin()"], host)).toBe("node");
});

test("a name stops at the limit, whole programs at a time", () => {
	const name = commandName(Array.from({ length: 100 }, (_, i) => `p${i}`).join("; "), () => true);
	expect(name.length).toBeLessThanOrEqual(COMMAND_LIMIT);
	expect(name.endsWith(";")).toBe(false);
	expect(isCommandName(name)).toBe(true);
});

test.each([
	"",
	"cargo build --release",
	"gh pr view 1",
	"-f x",
	"a\nb",
	"cargo Build",
	"x;y",
	"git password",
	"ls test",
])("%j is no command name", (name) => expect(isCommandName(name)).toBe(false));

// Windows finds a program by its extension rather than a mode bit.
test.skipIf(process.platform === "win32")(
	"a host runs a name on PATH or a path to a launchable file, from its directory",
	() => {
		const root = tempDir();
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(root, "bin", "data"), "x\n", { mode: 0o644 });
		const run = runs({ PATH: join(root, "bin") }, root);
		const on = (program: string, cd: string[] = []) => run(program, cd);
		expect(on("tool")).toBe(true);
		expect(on("bin/tool")).toBe(true);
		expect(on("hunter2")).toBe(false);
		expect(on("./hunter2")).toBe(false);
		expect(on("bin/data")).toBe(false);
		expect(on("./tool", ["bin"])).toBe(true);
		expect(on("./tool", ["."])).toBe(false);
	},
);

test("a Windows path names its program by its last part, without its extension", () => {
	const ran: string[] = [];
	const host = (program: string) => (ran.push(program), true);
	expect(argvName(["C:\\tools\\cargo.exe", "build"], host)).toBe("cargo build");
	expect(commandName("'C:\\tools\\gh.cmd' pr view 1", host)).toBe("gh pr");
	expect(ran).toEqual(["C:\\tools\\cargo.exe", "C:\\tools\\gh.cmd"]);
});
