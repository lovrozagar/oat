import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 20_000,
		coverage: {
			provider: "v8",
			include: [
				"src/runtime/poll.ts",
				"src/runtime/input.ts",
				"src/runtime/principals.ts",
				"src/runtime/wait.ts",
				"src/spec/query-capabilities.ts",
				"src/runtime/query-capabilities.ts",
				"src/runtime/upload-each.ts",
				"src/runtime/effects.ts",
				"src/runtime/exchanges.ts",
				"src/runtime/network.ts",
			],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
})
