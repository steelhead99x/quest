import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

// A temporary directory may itself sit under home, as TMPDIR=~/.cache/tmp does,
// so this checks the dirs are a fresh temporary one and not the host's own.
test("each test's state and config directories are temporary, apart from the host's", () => {
	const host = { XDG_STATE_HOME: join(homedir(), ".local", "state"), XDG_CONFIG_HOME: join(homedir(), ".config") };
	for (const [name, fallback] of Object.entries(host)) {
		const dir = process.env[name] ?? "";
		// Inside this test's own `quest-xdg-*` directory, wherever `tmpdir()` lies, even under the home directory.
		expect(dirname(dir).startsWith(join(tmpdir(), "quest-xdg-"))).toBe(true);
		expect(dir).not.toBe(fallback);
	}
});
