// Run a device tool, such as adb or ideviceinfo, with a deadline.

/** Runs a command and returns its standard output, throwing on failure. */
export type Shell = (command: string, args: string[]) => Promise<string>;

/** The real shell: fails on a missing tool, a non-zero exit, or `timeout` ms without exiting. */
export function shell(timeout = 30_000): Shell {
	return async (command, args) => {
		if (!Bun.which(command)) throw new Error(`${command} is not installed or not on PATH`);
		const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => child.kill(), timeout);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(timer);
		if (child.signalCode) throw new Error(`${command} ${args.join(" ")} did not finish within ${timeout} ms`);
		if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}: ${err.trim() || out.trim()}`);
		return out;
	};
}

/** Wait `ms` milliseconds. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
