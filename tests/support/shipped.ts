import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ImportGraph } from "./import-graph.ts"

/*
 * What the package must ship: every module the entry points reach, as built. Read from the source
 * graph, so no build is needed and a stale one cannot hide a gap.
 */

interface Manifest {
	bin?: string | Record<string, string>
	exports?: Record<string, { default?: string; types?: string } | string>
	files: string[]
}

const BUILT = /^\.?\/?dist\//

/** The source module a built path comes from: `dist/cli.js` → `src/cli.ts`. */
function sourceOf(built: string): string {
	return built.replace(BUILT, "src/").replace(/\.d\.ts$|\.js$/, ".ts")
}

/** The built path of a source module: `src/cli/main.ts` → `dist/cli/main.js`. */
function builtOf(source: string): string {
	return source.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")
}

/** Whether npm ships `path` under `files`: an entry is the file itself or a folder above it. */
function covered(path: string, files: readonly string[]): boolean {
	return files.some((entry) => {
		const clean = entry.replace(/^\.\//, "").replace(/\/$/, "")
		return path === clean || path.startsWith(`${clean}/`)
	})
}

/** The package's entry targets: its `exports`, and the built module each `bin` script imports. */
export function entryTargets(root: string, manifest: Manifest): string[] {
	const exported = Object.values(manifest.exports ?? {}).flatMap((target) =>
		typeof target === "string"
			? [target]
			: [target.default, target.types].filter((path): path is string => path !== undefined),
	)
	const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {})
	const binImports = bins.flatMap((bin) =>
		[...readFileSync(join(root, bin), "utf8").matchAll(/from "\.\.\/(dist\/[^"]+)"/g)].map(
			(match) => match[1] as string,
		),
	)
	return [...bins, ...exported, ...binImports].map((path) => path.replace(/^\.\//, ""))
}

/**
 * Paths the package needs that `files` leaves out: an entry target, or a built module an entry
 * reaches through its imports, static or dynamic.
 */
export function unshipped(root: string, manifest: Manifest, graph: ImportGraph): string[] {
	const targets = entryTargets(root, manifest)
	const seen = new Set<string>()
	const pending = targets.filter((path) => BUILT.test(path)).map(sourceOf)
	while (pending.length > 0) {
		const module = pending.pop() as string
		if (seen.has(module) || !graph.has(module)) continue
		seen.add(module)
		pending.push(...(graph.get(module) ?? []))
	}
	const needed = [...targets, ...[...seen].map(builtOf)]
	return [...new Set(needed)].filter((path) => !covered(path, manifest.files)).toSorted()
}
