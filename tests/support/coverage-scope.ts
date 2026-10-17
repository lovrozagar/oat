import { existsSync, readdirSync } from "node:fs"
import { join, matchesGlob, relative } from "node:path"

/* What coverage instruments: the one list vitest.config.ts and the floors guard both read. */
export const COVERAGE_INCLUDE: readonly string[] = ["src/**/*.ts", "lint/**/*.ts"]
export const COVERAGE_EXCLUDE: readonly string[] = [
	"**/*.test.ts",
	"**/__fixtures__/**",
	"**/*.d.ts",
	"**/index.ts",
	"lint/rule-harness.ts",
]

/** Every repo-relative module coverage instruments, sorted. */
export function instrumentedModules(root: string): string[] {
	return ["src", "lint"]
		.filter((dir) => existsSync(join(root, dir)))
		.flatMap((dir) =>
			readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => relative(root, join(entry.parentPath, entry.name))),
		)
		.filter((file) => COVERAGE_INCLUDE.some((glob) => matchesGlob(file, glob)))
		.filter((file) => !COVERAGE_EXCLUDE.some((glob) => matchesGlob(file, glob)))
		.toSorted()
}
