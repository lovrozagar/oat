import { readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import { POSTGRES_RANGE } from "../../src/reference/stores/postgres-driver.ts"

/*
 * `postgres` is an optional peer: a published install without it must start every command, so no
 * module the CLI or the package entry loads up front may import it. Only `import()` on the
 * Postgres backend's path reaches it, and the range the CLI asks for is the one package.json declares.
 */

const ROOT = join(import.meta.dirname, "..", "..")

interface Node {
	type: string
	importKind?: string
	exportKind?: string
	source?: { value?: unknown } | null
}

/* The modules `file` loads when it loads: value imports and re-exports, not types, not `import()`. */
function staticImports(file: string): string[] {
	const { program } = parseSync(file, readFileSync(join(ROOT, file), "utf8"))
	return (program.body as Node[])
		.filter((node) => ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type))
		.filter((node) => node.importKind !== "type" && node.exportKind !== "type")
		.map((node) => node.source?.value)
		.filter((source): source is string => typeof source === "string")
}

/** Every module loaded with `entry`, and the bare packages each one imports. */
function loadedWith(entry: string): Map<string, string[]> {
	const loaded = new Map<string, string[]>()
	const pending = [entry]
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (loaded.has(file)) continue
		const sources = staticImports(file)
		loaded.set(
			file,
			sources.filter((source) => !source.startsWith(".")),
		)
		for (const source of sources.filter((spec) => spec.startsWith(".")))
			pending.push(normalize(join(dirname(file), source)))
	}
	return loaded
}

describe("the postgres driver", () => {
	it.each(["src/cli.ts", "src/index.ts", "src/conformance/worker.ts"])("is not loaded with %s", (entry) => {
		const importers = [...loadedWith(entry)].filter(([, packages]) => packages.includes("postgres"))
		expect(importers.map(([file]) => file)).toEqual([])
	})

	it("is an optional peer at the range the CLI asks for, and the repo's own copy is in it", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			peerDependencies?: Record<string, string>
			peerDependenciesMeta?: Record<string, { optional?: boolean }>
			devDependencies: Record<string, string>
			dependencies?: Record<string, string>
		}
		expect(manifest.peerDependencies?.postgres).toBe(POSTGRES_RANGE)
		expect(manifest.peerDependenciesMeta?.postgres?.optional).toBe(true)
		expect(manifest.dependencies?.postgres).toBeUndefined()
		expect(manifest.devDependencies.postgres?.startsWith(POSTGRES_RANGE)).toBe(true)
	})
})
