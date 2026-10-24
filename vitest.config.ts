import { defineConfig } from "vitest/config"
import floors from "./coverage-floors.json" with { type: "json" }
import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE } from "./tests/support/coverage-scope.ts"

/*
 * Two projects. `unit`: colocated tests beside their module, socket-free, the only source of
 * coverage. `integration`: servers, the CLI end to end, regression goldens and structure checks,
 * which exercise whole runs and so would inflate any module's coverage without testing it.
 */
export default defineConfig({
	test: {
		globalSetup: ["tests/support/temp-root.ts"],
		/* GitHub Actions sets this for the test step itself; a test that runs `oat run` must not append to
		 * CI's own job summary. A test of the summary sets its own path. */
		env: { GITHUB_STEP_SUMMARY: "" },
		testTimeout: 20_000,
		execArgv: ["--expose-gc"],
		projects: [
			{ extends: true, test: { name: "unit", include: ["src/**/*.test.ts", "lint/**/*.test.ts"] } },
			{
				extends: true,
				test: {
					name: "integration",
					include: ["tests/{integration,regression,structure}/**/*.test.ts"],
					/* A hook here starts a server or runs oat whole (a golden run takes seconds); under a
					 * loaded host the 10s default timed one out with nothing wrong. 120s is over ten times
					 * the slowest such hook, so only a hang reaches it. */
					hookTimeout: 120_000,
				},
			},
		],
		coverage: {
			provider: "v8",
			include: [...COVERAGE_INCLUDE],
			exclude: [...COVERAGE_EXCLUDE],
			/* Per file, measured from unit tests alone: a floor is raised as tests land, never lowered,
			 * and reaches 100 for a directory when it joins the ratchet. */
			thresholds: floors,
		},
	},
})
