import { spawnSync } from "node:child_process"
import { importGraph } from "../support/import-graph.ts"
import { unshipped } from "../support/shipped.ts"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"

/*
 * The flare/honey layout: a unit test sits beside its module and opens no socket; servers and
 * whole runs live under tests/. Every module has a sibling test, except an index (pure re-exports)
 * and a file that declares only types. Modules without one today are listed; the list only shrinks.
 */

const ROOT = join(import.meta.dirname, "..", "..")

const UNTESTED: readonly string[] = [
	"src/conformance/expected-failures.ts",
	"src/conformance/feature-gate.ts",
	"src/conformance/fuzz.ts",
	"src/conformance/pool.ts",
	"src/conformance/rate-limit.ts",
	"src/conformance/seed-contract.ts",
	"src/conformance/shapes.ts",
	"src/conformance/specs.ts",
	"src/conformance/unique.ts",
	"src/conformance/worker.ts",
	"src/reference/store-api.ts",
	"src/reference/stores/memory.ts",
	"src/reference/stores/postgres.ts",
	"src/reference/stores/sqlite-driver.ts",
	"src/reference/stores/sqlite.ts",
	"src/report/diff.ts",
	"src/runtime/async.ts",
	"src/runtime/baseline.ts",
	"src/runtime/check-costs.ts",
	"src/runtime/check-ids.ts",
	"src/runtime/created-id.ts",
	"src/runtime/dummy.ts",
	"src/runtime/feature-gate.ts",
	"src/runtime/fence.ts",
	"src/runtime/headers.ts",
	"src/runtime/one-shot.ts",
	"src/runtime/payloads.ts",
	"src/runtime/profile.ts",
	"src/runtime/proven-id.ts",
	"src/runtime/query.ts",
	"src/runtime/root-read.ts",
	"src/runtime/server-errors.ts",
	"src/runtime/sse.ts",
	"src/runtime/target-version.ts",
	"src/runtime/unique.ts",
	"src/runtime/upload-each.ts",
	"src/runtime/validate.ts",
	"src/runtime/wait.ts",
]

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

	it("gives every module a sibling test, except an index and a types-only file", () => {
		const files = new Set(filesUnder("src"))
		const missing = [...files]
			.filter(isModule)
			.filter((file) => !file.endsWith("/index.ts") && !files.has(file.replace(/\.ts$/, ".test.ts")))
			.filter((file) => !declaresOnlyTypes(file))
		expect(missing).toEqual([...UNTESTED].toSorted())
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
		/* npm 10 prints an array of manifests, npm 12 an object keyed by name. */
		const manifests = Object.values(JSON.parse(packed.stdout) as object) as Array<{ files: Array<{ path: string }> }>
		const shipped = manifests.flatMap((manifest) => manifest.files.map((file) => file.path))
		expect(shipped.length).toBeGreaterThan(0)
		expect(shipped.filter((path) => /\.test\.|__fixtures__|^tests\/|^lint\//.test(path))).toEqual([])
	})
})
