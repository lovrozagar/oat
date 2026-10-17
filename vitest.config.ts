import { defineConfig } from "vitest/config"
import floors from "./coverage-floors.json" with { type: "json" }

/*
 * Two projects. `unit`: colocated tests beside their module, socket-free, the only source of
 * coverage. `integration`: servers, the CLI end to end, regression goldens and structure checks,
 * which exercise whole runs and so would inflate any module's coverage without testing it.
 */
export default defineConfig({
	test: {
		globalSetup: ["tests/support/temp-root.ts"],
		testTimeout: 20_000,
		execArgv: ["--expose-gc"],
		projects: [
			{ extends: true, test: { name: "unit", include: ["src/**/*.test.ts", "lint/**/*.test.ts"] } },
			{
				extends: true,
				test: { name: "integration", include: ["tests/{integration,regression,structure}/**/*.test.ts"] },
			},
		],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "lint/**/*.ts"],
			exclude: ["**/*.test.ts", "**/__fixtures__/**", "**/*.d.ts", "**/index.ts", "lint/rule-harness.ts"],
			/* Per file, measured from unit tests alone: a floor is raised as tests land, never lowered,
			 * and reaches 100 for a directory when it joins the ratchet. */
			thresholds: floors,
		},
	},
})
