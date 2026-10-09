import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 20_000,
		execArgv: ["--expose-gc"],
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
				"src/runtime/cookies.ts",
				"src/runtime/sse.ts",
				"src/runtime/transcript.ts",
				/* The files that carry the logic. Held to today's level as a floor — raise it as
				 * tests land, never lower it. The files above are held at 100%. */
				"src/runtime/checks.ts",
				"src/runtime/run.ts",
				"src/runtime/world.ts",
				"src/runtime/client.ts",
				"src/runtime/auth.ts",
				"src/runtime/fixture.ts",
				"src/runtime/teardown.ts",
			],
			thresholds: {
				"src/{runtime/poll,runtime/input,runtime/principals,runtime/wait,spec/query-capabilities,runtime/query-capabilities,runtime/upload-each,runtime/effects,runtime/exchanges,runtime/network,runtime/cookies,runtime/sse,runtime/transcript}.ts":
					{ branches: 100, functions: 100, lines: 100, statements: 100 },
				"src/runtime/checks.ts": { branches: 73, functions: 97, lines: 89, statements: 82 },
				"src/runtime/run.ts": { branches: 78, functions: 92, lines: 87, statements: 85 },
				"src/runtime/world.ts": { branches: 65, functions: 100, lines: 86, statements: 81 },
				"src/runtime/client.ts": { branches: 71, functions: 97, lines: 88, statements: 83 },
				"src/runtime/auth.ts": { branches: 80, functions: 84, lines: 91, statements: 87 },
				"src/runtime/fixture.ts": { branches: 55, functions: 81, lines: 69, statements: 61 },
				"src/runtime/teardown.ts": { branches: 60, functions: 83, lines: 74, statements: 71 },
			},
		},
	},
})
