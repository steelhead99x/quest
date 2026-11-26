// Gives each test its own XDG_STATE_HOME and XDG_CONFIG_HOME, so a test that calls `main()` in
// process never reads or writes the host's quest state, tokens, or record queue.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-xdg-"));
	process.env.XDG_STATE_HOME = join(root, "state");
	process.env.XDG_CONFIG_HOME = join(root, "config");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
