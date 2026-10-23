import { defineConfig } from "vitest/config"

/*
 * The packed package, installed into a temp consumer and driven through its bin. Run after a build
 * (`bun run test:e2e` builds first); slow by nature, so it stays out of `test`.
 */
export default defineConfig({
	test: {
		globalSetup: ["tests/support/temp-root.ts"],
		include: ["tests/e2e/**/*.test.ts"],
		testTimeout: 240_000,
		hookTimeout: 300_000,
		fileParallelism: false,
	},
})
