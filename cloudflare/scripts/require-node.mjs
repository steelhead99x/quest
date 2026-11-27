// Fails when `node` is Bun. Wrangler, and the workerd test pool it drives, need Node:
// on Bun, `wrangler types` dies resolving dummy.invalid on some networks and passes on
// others. A `bun run` under the root bunfig.toml (`run.bun`) puts a Bun `node` shim
// first on PATH for everything it starts, `quest gate` included, so say so here
// instead of failing later with a DNS error.
if (process.versions.bun) {
	console.error(
		"cloudflare/: `node` is Bun here, and Wrangler needs Node.\n" +
			"A `bun run` from the repository root put Bun's node shim on PATH. Run the Worker\n" +
			"recipes through `just worker-check` or `just worker-test`, which drop it, or from cloudflare/ directly.",
	);
	process.exit(1);
}
