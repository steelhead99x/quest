import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: the contributor tools run on Bun, and the Worker's tests run
// inside workerd with the deploy config's bindings, never contacting a Cloudflare account.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: "tools", include: ["test/*.test.ts"] } },
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
						remoteBindings: false,
						miniflare: {
							bindings: {
								AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
								GITHUB_CLIENT_ID: "Iv23test",
								GITHUB_CLIENT_SECRET: "test-client-secret",
								GITHUB_APP_SLUG: "quest-test",
								SCHEDULE_TIMEZONE: "UTC",
							},
						},
					}),
				],
				test: { name: "worker", include: ["test/worker/*.test.ts"] },
			},
		],
	},
});
