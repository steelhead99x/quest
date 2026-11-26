import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

test("each test's state and config directories are temporary, apart from the host's", () => {
	for (const name of ["XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
		const dir = process.env[name] ?? "";
		expect(dir).toContain("quest-xdg-");
		expect(dir.startsWith(join(homedir(), "."))).toBe(false);
	}
});
