import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { expect, test } from "vitest";

// A temporary directory may itself sit under home, as TMPDIR=~/.cache/tmp does,
// so this checks the dirs are a fresh temporary one and not the host's own.
test("each test's state and config directories are temporary, apart from the host's", () => {
	const host = [join(homedir(), ".local", "state"), join(homedir(), ".config")];
	for (const name of ["XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
		const dir = process.env[name] ?? "";
		expect(relative(tmpdir(), dir).split(sep)[0]).toMatch(/^quest-xdg-/);
		for (const own of host) {
			const inside = relative(own, dir);
			expect(inside === "" || !inside.startsWith("..")).toBe(false);
		}
	}
});
