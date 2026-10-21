import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import { EXPECTED } from "../../src/conformance/expected/table.ts"
import { inProcess, launch, reach } from "../../src/conformance/harness/launch.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * The shipped demo injects a handful of defects to show a first-time user what oat finds. A defect
 * it injects but never reports tells that user oat missed it. Its default defects, principals and
 * security are read from labs/demo.mjs itself, then its run is repeated in process against the
 * same reference: every defect it injects must be reported under the check that diagnoses it.
 */

const DEMO = join(import.meta.dirname, "..", "..", "labs", "demo.mjs")

interface Node {
	type: string
	[key: string]: unknown
}

/* A literal expression's value: objects, arrays, strings, numbers and booleans, as the demo writes them. */
function valueOf(node: Node): unknown {
	if (node.type === "Literal") return node.value
	if (node.type === "ArrayExpression") return (node.elements as Node[]).map(valueOf)
	if (node.type !== "ObjectExpression") throw new Error(`labs/demo.mjs: ${node.type} is not a literal`)
	return Object.fromEntries(
		(node.properties as Node[]).map((property) => {
			const key = property.key as Node
			return [key.type === "Identifier" ? key.name : key.value, valueOf(property.value as Node)]
		}),
	)
}

/** The value each named top-level `const` of labs/demo.mjs is declared with. */
function demoConstants(names: readonly string[]): Record<string, unknown> {
	const { program } = parseSync(DEMO, readFileSync(DEMO, "utf8"))
	const declarators = (program.body as unknown as Node[])
		.filter((statement) => statement.type === "VariableDeclaration")
		.flatMap((statement) => statement.declarations as Node[])
	return Object.fromEntries(
		names.map((name) => {
			const found = declarators.find((declarator) => (declarator.id as Node).name === name)
			if (found === undefined) throw new Error(`labs/demo.mjs declares no ${name}`)
			return [name, valueOf(found.init as Node)]
		}),
	)
}

describe("the shipped demo", () => {
	it(
		"reports every defect its default run injects, under the check that diagnoses it",
		{ timeout: 60_000 },
		async () => {
			const demo = demoConstants(["DEFAULT_DEFECTS", "principals", "security"])
			const defects = demo.DEFAULT_DEFECTS as DefectName[]
			expect(defects.length).toBeGreaterThan(0)
			const server = await launch({ backend: "memory", dialect: "postgrest", via: inProcess }, { defects })
			try {
				const result = await run({
					...reach(server),
					baseUrl: server.url,
					principals: demo.principals as never,
					security: demo.security as never,
					seed: 42,
					spec: `${server.url}/v1/openapi/spec`,
				})
				const reported = new Set(result.findings.map((finding) => finding.check))
				const unreported = defects.filter((defect) => !reported.has([EXPECTED[defect]].flat()[0] as string))
				expect(unreported).toEqual([])
			} finally {
				await server.close()
			}
		},
	)
})
