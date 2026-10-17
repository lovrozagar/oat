import { describe, expect, it } from "vitest"
import { rule } from "./boundaries.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE = "import is outside oat's module boundaries (see AGENTS.md: dependency arrows)"

/* One importing file per case: `from` imports `spec`, and the rule says whether that is allowed. */
function verdict(from: string, spec: string): boolean {
	return reportsOf(rule, { [from]: `import { x } from "${spec}"\n` }).length === 0
}

/* Down the layers, and within a layer's own group. */
const ALLOWED: Array<[string, string]> = [
	["src/cli.ts", "./conformance/suite.ts"],
	["src/cli/commands/run.ts", "../../report/render.ts"],
	["src/cli.ts", "./runtime/run.ts"],
	["src/index.ts", "./report/render.ts"],
	["src/config/define-config.ts", "../runtime/run.ts"],
	["src/report/render.ts", "../runtime/run.ts"],
	["src/conformance/suite.ts", "../reference/http.ts"],
	["src/conformance/suite.ts", "../report/render.ts"],
	["src/runtime/run.ts", "./checks.ts"],
	["src/runtime/run/stages/load.ts", "../../checks/registry.ts"],
	["src/runtime/checks.ts", "../client/request.ts"],
	["src/client/request.ts", "../credentials/store.ts"],
	["src/credentials/store.ts", "../runtime/body.ts"],
	["src/runtime/world.ts", "../spec/graph.ts"],
	["src/spec/graph.ts", "../security/redact.ts"],
	["src/spec/graph.ts", "../errors/usage-error.ts"],
	["src/spec/graph.ts", "../config/types/principals.ts"],
	["src/reference/http.ts", "../spec/types.ts"],
	["src/reference/http.ts", "./query.ts"],
	["src/errors/network.ts", "./usage-error.ts"],
	["src/spec/load.ts", "node:fs"],
	["src/spec/schema.ts", "ajv/dist/2020.js"],
	["src/spec/load.ts", "yaml"],
	["src/reference/stores/postgres.ts", "postgres"],
	["src/cli.ts", "@lovrozagar/oat"],
]

/* Against the arrows. */
const REFUSED: Array<[string, string]> = [
	["src/spec/graph.ts", "../runtime/world.ts"],
	["src/errors/network.ts", "../spec/graph.ts"],
	["src/config/types/principals.ts", "../define-config.ts"],
	["src/reference/http.ts", "../runtime/client.ts"],
	["src/runtime/world.ts", "../reference/http.ts"],
	["src/runtime/run.ts", "../reference/http.ts"],
	["src/runtime/checks.ts", "../report/render.ts"],
	["src/runtime/run.ts", "../conformance/suite.ts"],
	["src/report/render.ts", "../cli.ts"],
	["src/report/render.ts", "../config/define-config.ts"],
	["src/runtime/checks.ts", "./run.ts"],
	["src/spec/load.ts", "fs"],
	["src/runtime/client.ts", "postgres"],
	["src/runtime/client.ts", "lodash"],
	["src/misc/thing.ts", "../spec/graph.ts"],
	["src/runtime/world.ts", "../misc/thing.ts"],
]

describe("oat/boundaries", () => {
	it("allows the arrows: down the layers, and within a layer's own group", () => {
		expect(ALLOWED.filter(([from, spec]) => !verdict(from, spec))).toEqual([])
	})

	it("refuses an import against the arrows", () => {
		expect(REFUSED.filter(([from, spec]) => verdict(from, spec))).toEqual([])
	})

	it("checks every import form: type imports, re-exports and literal dynamic imports", () => {
		const fixture = {
			"src/spec/graph.ts": [
				'import type { A } from "../runtime/world.ts"',
				'export { b } from "../runtime/world.ts"',
				'export * from "../runtime/world.ts"',
				'export const c = () => import("../runtime/world.ts")',
				"export const d = (name: string) => import(name)",
				"export const e = 1",
			].join("\n"),
		}
		const reports = reportsOf(rule, fixture)
		expect(reports.map(({ line }) => line)).toEqual([1, 2, 3, 4])
		expect(reports[0]?.message).toBe(MESSAGE)
	})

	it("leaves tests, fixtures and code outside src alone", () => {
		const source = 'import { x } from "../runtime/world.ts"\nimport { y } from "lodash"\n'
		const fixture = {
			"src/spec/graph.test.ts": source,
			"src/spec/__fixtures__/a.ts": source,
			"tests/integration/a.test.ts": source,
			"lint/a.ts": source,
			"labs/demo.ts": source,
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the oat plugin entry", () => {
		const fixture = { "src/spec/graph.ts": 'import { x } from "../runtime/world.ts"\n' }
		expect(oxlintReports("boundaries", fixture).length).toBe(1)
	})
})
