// `quest setup`'s user-level Claude Code settings, and `quest hook`, which handles its hooks.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { REFERENCE_LINE } from "../src/core";
import {
	BASH_MAX_TIMEOUT_MS,
	CLAUDE_ENV,
	CLAUDE_HOOKS,
	CODEX_HOOKS,
	CONTEXT_LIMIT,
	HOOK_COMMAND,
	type Target,
	WORKTREE_COMMAND,
	WORKTREE_HOOKS,
	hook,
	settingsPath,
	setup,
	targets,
} from "../src/cli/hooks";
import { RULES } from "../src/cli/rules";
import { init } from "../src/cli/setup";
import { CONTEXT } from "../src/cli/skills";
import { contextPacks } from "../src/cli/context";
import { readCalls } from "../src/cli/calls";
import { tempDir } from "./fixture";

const ours = { type: "command", command: HOOK_COMMAND };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const claude = (path: string): Target => ({ name: "Claude Code", path, hooks: CLAUDE_HOOKS, claude: true });

test("settings live in CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
	expect(settingsPath({ CLAUDE_CONFIG_DIR: "/profiles/work" })).toBe(join("/profiles/work", "settings.json"));
	expect(settingsPath({})).toMatch(/[/\\]\.claude[/\\]settings\.json$/);
});

test("setup creates the settings file with the timeout and every hook, then changes nothing", () => {
	const path = join(tempDir(), "profile", "settings.json");
	expect(setup(claude(path))).toEqual([
		`${path}: installed Quest's hooks`,
		`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
		`${path}: env.BASH_DEFAULT_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
	]);
	const settings = read(path);
	expect(settings.env).toEqual(CLAUDE_ENV);
	for (const { event, matcher } of CLAUDE_HOOKS)
		expect(settings.hooks[event]).toEqual([{ ...(matcher ? { matcher } : {}), hooks: [ours] }]);
	const written = readFileSync(path, "utf8");
	expect(written.endsWith("}\n")).toBe(true);
	expect(setup(claude(path))).toEqual([]);
	expect(readFileSync(path, "utf8")).toBe(written);
});

test("setup replaces a different timeout, and removal leaves the user's own", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ env: { FOO: "1", BASH_MAX_TIMEOUT_MS: "600000" } }));
	expect(setup(claude(path))).toContain(`${path}: env.BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS} (was "600000")`);
	expect(read(path).env).toEqual({ FOO: "1", ...CLAUDE_ENV });
	expect(setup(claude(path), { remove: true })).toEqual([
		`${path}: removed Quest's hooks`,
		`${path}: removed env.BASH_MAX_TIMEOUT_MS`,
		`${path}: removed env.BASH_DEFAULT_TIMEOUT_MS`,
	]);
	expect(read(path)).toEqual({ env: { FOO: "1" } });

	writeFileSync(path, JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "600000", BASH_DEFAULT_TIMEOUT_MS: "1000" } }));
	expect(setup(claude(path), { remove: true })).toEqual([]);
	expect(read(path)).toEqual({ env: { BASH_MAX_TIMEOUT_MS: "600000", BASH_DEFAULT_TIMEOUT_MS: "1000" } });
});

test("setup keeps other settings and hooks in place", () => {
	const path = join(tempDir(), "settings.json");
	const theirs = { hooks: [{ type: "command", command: "dev-shell-hook claude", timeout: 600 }] };
	writeFileSync(path, JSON.stringify({ theme: "dark", hooks: { SessionStart: [theirs] }, env: { A: "1" } }));
	setup(claude(path));
	const settings = read(path);
	expect(Object.keys(settings)).toEqual(["theme", "hooks", "env"]);
	expect(settings.hooks.SessionStart[0]).toEqual(theirs);
	expect(settings.hooks.SessionStart).toHaveLength(2);
	expect(setup(claude(path), { remove: true })).toHaveLength(3);
	expect(read(path)).toEqual({ theme: "dark", hooks: { SessionStart: [theirs] }, env: { A: "1" } });
});

test("setup replaces an earlier version's entries, including one sharing a group", () => {
	const path = join(tempDir(), "settings.json");
	const theirs = { type: "command", command: "other" };
	writeFileSync(
		path,
		JSON.stringify({
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [ours] }],
				PreToolUse: [{ matcher: "Bash", hooks: [theirs, ours] }],
			},
		}),
	);
	expect(setup(claude(path))).toContain(`${path}: installed Quest's hooks`);
	const settings = read(path);
	expect(settings.hooks.PreToolUse).toEqual([
		{ matcher: "Bash", hooks: [theirs] },
		{ matcher: CLAUDE_HOOKS[2]!.matcher, hooks: [ours] },
	]);
	expect(settings.hooks.SessionStart).toEqual([{ matcher: CLAUDE_HOOKS[0]!.matcher, hooks: [ours] }]);
	expect(setup({ ...claude(path), hooks: [{ event: "Stop" }] })).toEqual([`${path}: installed Quest's hooks`]);
	expect(Object.keys(read(path).hooks)).toEqual(["PreToolUse", "Stop"]);
});

test("setup widens an earlier version's tool matchers to the question dialogs", () => {
	const dir = tempDir();
	const path = join(dir, "settings.json");
	writeFileSync(
		path,
		JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit", hooks: [ours] }] } }),
	);
	expect(setup(claude(path))).toContain(`${path}: installed Quest's hooks`);
	expect(read(path).hooks.PreToolUse).toEqual([
		{ matcher: "Bash|Write|Edit|MultiEdit|AskUserQuestion", hooks: [ours] },
	]);
	const hooks = join(dir, "hooks.json");
	writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|apply_patch", hooks: [ours] }] } }));
	expect(setup({ name: "Codex", path: hooks, hooks: CODEX_HOOKS, claude: false })).toEqual([
		`${hooks}: installed Quest's hooks`,
	]);
	expect(read(hooks).hooks.PreToolUse).toEqual([
		{ matcher: "Bash|apply_patch|request_user_input|request_user_input_async", hooks: [ours] },
	]);
});

test("Codex's hooks file gets its hooks and their settings, but no timeout", () => {
	const path = join(tempDir(), "hooks.json");
	const codex: Target = { name: "Codex", path, hooks: CODEX_HOOKS, claude: false };
	expect(setup(codex)).toEqual([`${path}: installed Quest's hooks`]);
	const settings = read(path);
	expect(settings.env).toBeUndefined();
	expect(settings.hooks.SessionStart).toEqual([
		{ matcher: CODEX_HOOKS[0]!.matcher, hooks: [{ ...ours, additionalContextLimit: CONTEXT_LIMIT }] },
	]);
	expect(setup(codex)).toEqual([]);
	// A changed handler setting is an earlier version's entry, replaced.
	expect(setup({ ...codex, hooks: [{ event: "SessionStart", settings: { additionalContextLimit: 1 } }] })).toEqual([
		`${path}: installed Quest's hooks`,
	]);
	expect(setup(codex, { remove: true })).toEqual([`${path}: removed Quest's hooks`]);
	expect(read(path)).toEqual({});
});

test("setup configures Codex only where its home exists", () => {
	const home = tempDir();
	const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
	expect(targets(env).map((target) => target.name)).toEqual(["Claude Code"]);
	mkdirSync(env.CODEX_HOME);
	expect(targets(env).map((target) => target.path)).toEqual([
		join(home, "claude", "settings.json"),
		join(home, "codex", "hooks.json"),
	]);
});

test("removing Quest's only settings drops the hooks and env keys", () => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark" }));
	setup(claude(path));
	setup(claude(path), { remove: true });
	expect(read(path)).toEqual({ theme: "dark" });
	expect(setup(claude(path), { remove: true })).toEqual([]);
});

test("setup installs the worktree hooks on request, keeps them on rerun, and replaces pasted ones", () => {
	const path = join(tempDir(), "settings.json");
	const pasted = { type: "command", command: `command -v quest >/dev/null || exit 1; ${WORKTREE_COMMAND}` };
	const worktree = { type: "command", command: WORKTREE_COMMAND };
	writeFileSync(
		path,
		JSON.stringify({
			hooks: { WorktreeCreate: [{ hooks: [pasted] }], SessionEnd: [{ hooks: [{ ...pasted, timeout: 60 }] }] },
		}),
	);
	setup(claude(path));
	const settings = read(path);
	expect(settings.hooks.WorktreeCreate).toEqual([{ hooks: [worktree] }]);
	expect(settings.hooks.SessionEnd).toEqual([{ hooks: [{ ...worktree, timeout: 60 }] }]);
	expect(settings.hooks.SessionStart).toEqual([
		{ matcher: CLAUDE_HOOKS[0]!.matcher, hooks: [ours] },
		{ hooks: [worktree] },
	]);
	expect(Object.keys(settings.hooks).sort()).toEqual(
		[...new Set([...CLAUDE_HOOKS, ...WORKTREE_HOOKS].map((h) => h.event))].sort(),
	);
	expect(setup(claude(path))).toEqual([]);
	expect(setup(claude(path), { worktrees: true })).toEqual([]);

	expect(setup(claude(path), { worktrees: false })).toEqual([`${path}: installed Quest's hooks`]);
	expect(Object.keys(read(path).hooks)).toEqual(CLAUDE_HOOKS.map((h) => h.event));
	expect(setup(claude(path))).toEqual([]);
	expect(setup(claude(path), { worktrees: true })).toEqual([`${path}: installed Quest's hooks`]);
	setup(claude(path), { remove: true });
	expect(read(path)).toEqual({});

	const codex = join(tempDir(), "hooks.json");
	setup({ name: "Codex", path: codex, hooks: CODEX_HOOKS, claude: false }, { worktrees: true });
	expect(Object.keys(read(codex).hooks)).toEqual(CODEX_HOOKS.map((h) => h.event));
});

test.each([
	["invalid JSON", "{ nope"],
	["a JSON array", "[]"],
	["env that is not an object", '{"env": "x"}'],
	["env that is not an object, with valid hooks", '{"env": [], "hooks": {}}'],
	["hooks that are not an object", '{"hooks": []}'],
	["hooks that are malformed, with a valid env", '{"env": {}, "hooks": {"SessionStart": [1]}}'],
	["an event that is not an array", '{"hooks": {"SessionStart": {}}}'],
	["a group without handlers", '{"hooks": {"SessionStart": [{"matcher": "startup"}]}}'],
])("setup refuses settings with %s and leaves them unchanged", (_, content) => {
	const path = join(tempDir(), "settings.json");
	writeFileSync(path, content);
	expect(() => setup(claude(path))).toThrow(path);
	expect(() => setup(claude(path), { remove: true })).toThrow(path);
	expect(readFileSync(path, "utf8")).toBe(content);
});

/** A checkout whose root instructions hold `instructions`, with a nested working directory. */
function checkout(instructions: string | null): string {
	const dir = tempDir();
	mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	if (instructions !== null) {
		writeFileSync(join(dir, "AGENTS.md"), instructions);
		if (instructions.includes(REFERENCE_LINE)) init(dir);
	}
	return join(dir, "src", "deep");
}

test.each(["SessionStart", "SubagentStart"])("%s adds the rules in a repository that uses Quest", (event) => {
	const cwd = checkout(`# Agents\n\n${REFERENCE_LINE}\n`);
	expect(JSON.parse(hook({ hook_event_name: event, cwd, source: "compact" }))).toEqual({
		hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT },
	});
});

test("SessionStart adds nothing where the repository does not use Quest", () => {
	expect(hook({ hook_event_name: "SessionStart", cwd: checkout("# Agents\n\nRun the tests.\n") })).toBe("");
	expect(hook({ hook_event_name: "SessionStart", cwd: checkout(null) })).toBe("");
	expect(hook({ hook_event_name: "SessionStart", cwd: tempDir() })).toBe("");
});

/** Hook dependencies writing to a fresh state directory, sampling a fixed counter, with `cat` and `ls` on PATH. */
function sampled(usage = 5_000) {
	// Stub programs, since a host such as NixOS keeps neither in /bin or /usr/bin; Windows launches by extension.
	const bin = tempDir();
	const stub = process.platform === "win32" ? ".cmd" : "";
	for (const program of ["cat", "ls"]) writeFileSync(join(bin, program + stub), "#!/bin/sh\n", { mode: 0o755 });
	const env = { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), PATH: bin };
	const sample = () => ({ at: "2026-11-15T10:00:00.000Z", cgroup: "/app.slice/agent.scope", usage });
	return { env, sample, lines: () => readCalls(Date.parse("2026-11-15T00:00:00Z"), env) };
}

test("PreToolUse denies a call that breaks a checked rule, only where the repository uses Quest", () => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const deps = sampled();
	const call = {
		hook_event_name: "PreToolUse",
		cwd,
		session_id: "s1",
		tool_use_id: "t1",
		tool_name: "Bash",
		tool_input: { command: "git push" },
	};
	const output = JSON.parse(hook(call, deps));
	expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
	expect(output.hookSpecificOutput.permissionDecisionReason).toContain("refspec");
	// A denied call never runs, so nothing samples it.
	expect(deps.lines()).toEqual([]);
	expect(hook({ ...call, tool_input: { command: "git push origin refs/heads/a:refs/heads/a" } }, deps)).toBe("");
	expect(hook({ ...call, cwd: checkout(null) }, deps)).toBe("");
	expect(deps.lines().map((l) => l.kind)).toEqual(["start"]);
	expect(() => hook({ hook_event_name: "PreToolUse", cwd }, deps)).toThrow("tool_name");
});

test("PreToolUse denies a question dialog that recommends no option, in Claude Code and Codex", () => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const deps = sampled();
	const ask = (tool_name: string, labels: string[], extra = {}) =>
		hook(
			{
				hook_event_name: "PreToolUse",
				cwd,
				session_id: "s1",
				tool_use_id: "t1",
				tool_name,
				tool_input: {
					questions: [{ question: "Which?", header: "Pick", options: labels.map((label) => ({ label })) }],
				},
				...extra,
			},
			deps,
		);
	const codex = { turn_id: "turn-1" };
	for (const [tool, extra] of [
		["AskUserQuestion", {}],
		["request_user_input", codex],
		["request_user_input_async", codex],
	] as const) {
		const output = JSON.parse(ask(tool, ["Keep it", "Drop it"], extra));
		expect(output.hookSpecificOutput).toEqual({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: RULES.recommend,
		});
		expect(ask(tool, ["Keep it (Recommended)", "Drop it"], extra)).toBe("");
	}
	// A dialog is no shell call, so nothing samples it.
	expect(deps.lines()).toEqual([]);
});

test("the tool hooks sample each shell call's start and return, naming its session, agent, and background task", () => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const deps = sampled();
	const claude = { cwd, session_id: "s1", agent_id: "a1", tool_use_id: "t1", tool_name: "Bash" };
	const command = `cat > x <<'EOF'\n${"y".repeat(300)}\nEOF`;
	expect(hook({ ...claude, hook_event_name: "PreToolUse", tool_input: { command } }, deps)).toBe("");
	expect(
		hook(
			{
				...claude,
				hook_event_name: "PostToolUseFailure",
				tool_input: { command },
				tool_response: { backgroundTaskId: "b7" },
			},
			deps,
		),
	).toBe("");
	const codex = { cwd, session_id: "c1", turn_id: "u1", tool_use_id: "t2", tool_name: "Bash" };
	hook({ ...codex, hook_event_name: "PreToolUse", tool_input: { command: "ls -la hunter2" } }, deps);
	hook(
		{ ...codex, hook_event_name: "PostToolUse", tool_input: { command: "ls -la hunter2" }, tool_response: "ok" },
		deps,
	);
	// Edits are no shell calls.
	hook({ ...claude, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: {} }, deps);
	const sample = { at: "2026-11-15T10:00:00.000Z", cgroup: "/app.slice/agent.scope", usage: 5_000 };
	expect(deps.lines()).toEqual([
		{
			kind: "start",
			harness: "claude",
			session: "s1",
			agent: "a1",
			call: "t1",
			command: "cat",
			...sample,
		},
		{ kind: "end", harness: "claude", session: "s1", agent: "a1", call: "t1", task: "b7", ...sample },
		{ kind: "start", harness: "codex", session: "c1", agent: null, call: "t2", command: "ls", ...sample },
		{ kind: "end", harness: "codex", session: "c1", agent: null, call: "t2", task: null, ...sample },
	]);
	expect(() =>
		hook({ ...claude, tool_use_id: undefined, hook_event_name: "PostToolUse", tool_input: {} }, deps),
	).toThrow("tool_use_id");
});

/** A background task as Claude Code lists it in a Stop hook's input. */
const shell = (id: string, command: string) => ({ id, type: "shell", status: "running", description: id, command });

test.each([
	["Stop", "transcript_path"],
	["SubagentStop", "agent_transcript_path"],
])("%s refuses while a gate, agent turn, or wait the agent started runs in the background", (event, key) => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const transcript = join(tempDir(), "agent.jsonl");
	writeFileSync(
		transcript,
		["b1", "b4", "b5", "b7", "b8", "b9", "c1", "c2", "c3", "c4"]
			.map((id) => `{"content":"Command running in background with ID: ${id}. Output is being written to: x"}\n`)
			.join(""),
	);
	const gate = shell("b1", "cd repo && quest gate just test > .tmp/test.log 2>&1");
	const agent = shell("b4", "quest agent start .worktrees/a --prompt 'go' > .tmp/a.log");
	const wait = shell("b5", "bun run --silent quest wait 806 --since 2026-11-21T00:00:00Z");
	// The global --root, in each spelling, still names the command.
	const rooted = shell("b9", "quest --root .worktrees/a --root='a b' --root a\\ b wait 807");
	const nested = shell("c2", "cd x && bash -c '/nix/store/q/bin/quest gate quest wait 808'");
	const loop = shell("c3", 'for target in check test; do quest gate just "$target"; done');
	const login = shell("c4", "/bin/bash -lc 'quest agent resume .worktrees/a'");
	const stop = {
		hook_event_name: event,
		cwd,
		session_id: "s1",
		transcript_path: transcript,
		[key]: transcript,
		stop_hook_active: true,
		background_tasks: [
			gate,
			// Another agent's gate and agent turn.
			shell("b2", 'quest --root "a b" gate just check'),
			shell("b6", "quest agent resume .worktrees/b --prompt 'more'"),
			// This agent's commands that it need not block on.
			shell("b3", "npm run dev"),
			agent,
			wait,
			shell("b7", "quest agent stop .worktrees/a"),
			shell("b8", "quest waiting"),
			rooted,
			// A quoted argument runs nothing.
			shell("c1", "tail -F .tmp/a.log | grep 'quest wait 806'"),
			nested,
			loop,
			login,
			{ id: "a1", type: "subagent", status: "running", description: "review" },
		],
	};
	// A user's own state, so a sender's failure on this host is never said here; this checkout has no origin.
	const deps = sampled();
	const output = JSON.parse(hook(stop, deps));
	expect(output.decision).toBe("block");
	// Every turn end records the shell tasks still running, so a background call's end is known.
	expect(deps.lines()[0]).toMatchObject({
		kind: "stop",
		harness: "claude",
		session: "s1",
		running: ["b1", "b2", "b6", "b3", "b4", "b5", "b7", "b8", "b9", "c1", "c2", "c3", "c4"],
	});
	expect(output.reason.split("\n").filter((line: string) => line.startsWith("- "))).toEqual([
		`- ${gate.command}`,
		`- ${agent.command}`,
		`- ${wait.command}`,
		`- ${rooted.command}`,
		`- ${nested.command}`,
		`- ${loop.command}`,
		`- ${login.command}`,
	]);
	// Without a transcript, every running gate counts as the agent's, but no agent turn or wait does.
	const unowned = JSON.parse(hook({ ...stop, [key]: "" }, deps)).reason;
	expect(unowned).toContain("just check");
	expect(unowned).toContain(nested.command);
	expect(unowned).toContain(loop.command);
	for (const task of [agent, wait, rooted, login]) expect(unowned).not.toContain(task.command);
	const gates = new Set(["b1", "b2", "c2", "c3"]);
	const ungated = { ...stop, background_tasks: stop.background_tasks.filter((task) => !gates.has(task.id)) };
	expect(hook({ ...ungated, [key]: "" }, deps)).toBe("");
	// A running agent turn or wait alone still holds the agent that started it.
	expect(JSON.parse(hook(ungated, deps)).reason).toContain(wait.command);
	// It lets the turn end once they end, and outside a repository that uses Quest.
	const owned = new Set(["b1", "b4", "b5", "b9", "c2", "c3", "c4"]);
	expect(hook({ ...stop, background_tasks: stop.background_tasks.filter((task) => !owned.has(task.id)) }, deps)).toBe(
		"",
	);
	expect(hook({ ...stop, cwd: checkout(null) }, deps)).toBe("");
	expect(() => hook({ hook_event_name: event, cwd }, deps)).toThrow("background_tasks");
});

test("PreToolUse lazily injects matching topic packs once per session and resets on compact", () => {
	const cwd = checkout(`${REFERENCE_LINE}\n`);
	const deps = sampled();
	const edit = (file_path: string, extra = {}) =>
		hook(
			{
				hook_event_name: "PreToolUse",
				cwd,
				session_id: "s-packs",
				tool_use_id: "t1",
				tool_name: "Edit",
				tool_input: { file_path, old_string: "a", new_string: "b" },
				...extra,
			},
			deps,
		);
	// First Rust edit injects the rust pack; a second Rust edit injects nothing.
	expect(JSON.parse(edit("src/lib.rs"))).toEqual({
		hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["rust"]) },
	});
	expect(edit("src/main.rs")).toBe("");
	// A UniFFI Rust edit injects only the unseen uniffi pack.
	expect(JSON.parse(edit("rs/moq-ffi/src/lib.rs"))).toEqual({
		hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["uniffi"]) },
	});
	// A PR Bash command injects the pr pack once (including the checkout's `bun run --silent quest` launcher).
	const prCall = {
		hook_event_name: "PreToolUse",
		cwd,
		session_id: "s-packs",
		tool_use_id: "t2",
		tool_name: "Bash",
		tool_input: { command: "bun run --silent quest pr list" },
	};
	expect(hook({ ...prCall, session_id: "s-bun-other", tool_input: { command: "bun run test" } }, deps)).toBe("");
	expect(JSON.parse(hook(prCall, deps))).toEqual({
		hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["pr"]) },
	});
	expect(hook(prCall, deps)).toBe("");
	// Wrapped PR commands (`nix develop --command`, `bash -c`, `env`) also inject the pr pack once.
	for (const [session_id, command] of [
		["s-nix-pr", "nix develop --command quest pr list"],
		["s-sh-pr", "env FOO=1 bash -c 'gh pr list'"],
	] as const) {
		expect(JSON.parse(hook({ ...prCall, session_id, tool_input: { command } }, deps))).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["pr"]) },
		});
	}
	// Codex apply_patch injects ts on TypeScript files.
	expect(
		JSON.parse(
			hook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: "s-packs",
					turn_id: "turn-1",
					tool_use_id: "t3",
					tool_name: "apply_patch",
					tool_input: { command: "*** Begin Patch\n*** Update File: src/app.ts\n-a\n+b\n*** End Patch" },
				},
				deps,
			),
		),
	).toEqual({
		hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["ts"]) },
	});
	// Resume preserves injected packs; compact resets them so they re-inject on next matching edit.
	hook({ hook_event_name: "SessionStart", cwd, session_id: "s-packs", source: "resume" }, deps);
	expect(edit("src/lib.rs")).toBe("");
	hook({ hook_event_name: "SessionStart", cwd, session_id: "s-packs", source: "compact" }, deps);
	expect(JSON.parse(edit("src/lib.rs"))).toEqual({
		hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contextPacks(["rust"]) },
	});
});

test("hook refuses malformed input and events it does not handle", () => {
	expect(() => hook({ cwd: "/" })).toThrow("hook_event_name");
	expect(() => hook({ hook_event_name: "Notification", cwd: "/" })).toThrow("quest setup");
});
