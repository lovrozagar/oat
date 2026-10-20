import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import { sourceOf } from "../support/shipped.ts"

/*
 * The plain scripts no compiler checks: `bin/*` and `labs/*.mjs`. Each relative import must name a
 * file that exists, and one into the build output must name a module the sources still have, so a
 * moved module breaks this test instead of the script. A dynamic import takes a string literal, or
 * there is nothing to check.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const BUILT = /^dist\//

/** The scripts to check, relative to the root. */
function scripts(): string[] {
	const labs = readdirSync(join(ROOT, "labs"))
		.filter((name) => name.endsWith(".mjs"))
		.map((name) => `labs/${name}`)
	const bins = readdirSync(join(ROOT, "bin")).map((name) => `bin/${name}`)
	return [...bins, ...labs].toSorted()
}

interface Node {
	type: string
	source?: Node | null
	value?: unknown
}

/** Every node under `node`, depth first. */
function* walk(node: unknown): Generator<Node> {
	if (Array.isArray(node)) {
		for (const child of node) yield* walk(child)
		return
	}
	if (node === null || typeof node !== "object") return
	if (typeof (node as Node).type === "string") yield node as Node
	for (const child of Object.values(node)) yield* walk(child)
}

const SOURCED = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"])

/** Each import's specifier, or `null` for a dynamic import computed at run time. */
function specifiers(file: string, code: string): Array<string | null> {
	const { program } = parseSync(file, code)
	return [...walk(program)]
		.filter((node) => SOURCED.has(node.type) && node.source)
		.map((node) => {
			const value = node.source?.type === "Literal" ? node.source.value : undefined
			return typeof value === "string" ? value : null
		})
}

/** Whether a relative specifier in `file` lands on a file, mapping a built path to its source. */
function resolves(file: string, specifier: string): boolean {
	const target = relative(ROOT, join(ROOT, dirname(file), specifier))
	return existsSync(join(ROOT, BUILT.test(target) ? sourceOf(target) : target))
}

/** The imports in `file` that name no module, as `file: specifier`. */
function broken(file: string, code: string): string[] {
	return specifiers(file, code)
		.filter((specifier) => specifier === null || (specifier.startsWith(".") && !resolves(file, specifier)))
		.map((specifier) => `${file}: ${specifier ?? "<computed import()>"}`)
}

describe("script imports", () => {
	it("checks the bin and the labs scripts", () => {
		expect(scripts()).toEqual(expect.arrayContaining(["bin/oat.js", "labs/bisect.mjs", "labs/demo.mjs"]))
	})

	it("resolves every relative import in bin/* and labs/*.mjs", () => {
		const unresolved = scripts().flatMap((file) => broken(file, readFileSync(join(ROOT, file), "utf8")))
		expect(unresolved).toEqual([])
	})

	it("reads imports the way it is meant to", () => {
		const code = [
			`import { a } from "../dist/cli.js"`,
			`import b from "node:fs"`,
			`export { c } from "./missing.mjs"`,
			`const d = await import("../dist/gone.js")`,
			"const e = await import(`../dist/${name}`)",
		].join("\n")
		expect(broken("labs/x.mjs", code)).toEqual([
			"labs/x.mjs: ./missing.mjs",
			"labs/x.mjs: ../dist/gone.js",
			"labs/x.mjs: <computed import()>",
		])
	})
})
