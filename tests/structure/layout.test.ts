import { spawnSync } from "node:child_process"
import { importGraph } from "../support/import-graph.ts"
import { packedManifests } from "../support/npm-pack.ts"
import { ENTRY_POINTS } from "../support/coverage-scope.ts"
import { unshipped } from "../support/shipped.ts"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"

/*
 * The flare/honey layout: a unit test sits beside its module and opens no socket; servers and
 * whole runs live under tests/. Every module has a sibling test, except an index (pure re-exports),
 * a file that declares only types, and a process entry point, which entries.test.ts proves thin.
 */

const ROOT = join(import.meta.dirname, "..", "..")

function filesUnder(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
		.toSorted()
}

const SOCKETS = /from "node:(?:http|https|net|tls|dgram)"|reference\/http\.ts"|\bcreateServer\(|\.listen\(|\bfetch\(/

const TYPE_ONLY = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"])

/* A file whose every statement is a type: an interface, an alias, or a type-only import or export. */
function declaresOnlyTypes(file: string): boolean {
	const { program } = parseSync(file, readFileSync(join(ROOT, file), "utf8"))
	return program.body.every((statement) => {
		if (TYPE_ONLY.has(statement.type)) return true
		if (statement.type === "ImportDeclaration") return statement.importKind === "type"
		if (statement.type === "ExportNamedDeclaration") {
			return statement.exportKind === "type" || TYPE_ONLY.has(statement.declaration?.type ?? "")
		}
		return false
	})
}

const isTest = (file: string): boolean => file.endsWith(".test.ts")
const isModule = (file: string): boolean =>
	file.endsWith(".ts") && !isTest(file) && !file.includes("/__fixtures__/") && !file.endsWith(".d.ts")

describe("layout", () => {
	it("has no test/ directory: tests sit beside their module or under tests/", () => {
		expect(existsSync(join(ROOT, "test"))).toBe(false)
	})

	it("keeps colocated tests socket-free", () => {
		const opening = filesUnder("src")
			.filter(isTest)
			.filter((file) => SOCKETS.test(readFileSync(join(ROOT, file), "utf8")))
		expect(opening).toEqual([])
	})

	it("gives every module a sibling test, except an index, a types-only file and an entry point", () => {
		const files = new Set(filesUnder("src"))
		const missing = [...files]
			.filter(isModule)
			.filter((file) => !file.endsWith("/index.ts") && !files.has(file.replace(/\.ts$/, ".test.ts")))
			.filter((file) => !declaresOnlyTypes(file) && !ENTRY_POINTS.includes(file))
		expect(missing).toEqual([])
	})

	it("ships every module the entry points reach, and the entry targets themselves", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
		const graph = importGraph(ROOT, "src")
		expect(unshipped(ROOT, manifest, graph)).toEqual([])
		/* The list phases 3 to 7.1 shipped with: the check names what it left out. */
		const narrow = [
			"bin/oat.js",
			"dist/cli.js",
			"dist/index.js",
			"dist/index.d.ts",
			"dist/config",
			"dist/conformance",
			"dist/reference",
			"dist/report",
			"dist/runtime",
			"dist/spec",
		]
		const missing = unshipped(ROOT, { ...manifest, files: narrow }, graph)
		expect(missing).toEqual(
			expect.arrayContaining(["dist/cli/main.js", "dist/errors/message.js", "dist/security/redact.js"]),
		)
	})

	it("ships no test, fixture or tests/ file in the package", () => {
		const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: ROOT,
			encoding: "utf8",
		})
		const manifests = packedManifests(packed.stdout)
		expect(manifests).toHaveLength(1)
		const shipped = manifests.flatMap((manifest) => manifest.files.map((file) => file.path))
		expect(shipped.length).toBeGreaterThan(0)
		expect(shipped.filter((path) => /\.test\.|__fixtures__|^tests\/|^lint\//.test(path))).toEqual([])
	})
})
