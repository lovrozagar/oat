import { describe, expect, it } from "vitest"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"
import { TEMPLATE } from "../../src/reference/dialect/presets.ts"
import { toCanonicalFilter } from "../../src/reference/dialect/canonical.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"
import { listening } from "../../src/conformance/harness/launch.ts"

/*
 * A backend that answers 200 with the whole collection for an operator it does not know, a sort
 * direction it does not know, or a term it cannot parse has silently dropped the caller's intent.
 * oat can only ask that when it knows how the grammar is spelled — declared, never guessed: a
 * request built from a guessed grammar is malformed by accident, and its answer proves nothing.
 */

const FILTER = { conj: { and: "and" }, ops: { eq: "eq" }, term: "{conj}_{field}_{op}_{value}" }
const SORT = { asc: "ascending", desc: "descending", term: "{field}_{direction}" }

function context(query: Record<string, unknown>, parameterDescription = "") {
	const doc = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "notes.list",
					parameters: [
						{ description: parameterDescription, in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "sort", schema: { type: "string" } },
					],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
										type: "array",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", name: "note" },
					"x-query": { filterable: ["name"], sortable: ["name"], ...query },
				},
			},
		},
	} as unknown as OpenApiDocument
	const model = buildModel(dereference(doc).doc)
	const listOp = model.byOperationId.get("notes.list")
	if (listOp === undefined || listOp.query === null) throw new Error("fixture incomplete")
	return checkContext({
		client: new Client({ baseUrl: "http://127.0.0.1:1", redactor: new Redactor() }),
		entityName: "note",
		findings: new FindingCollector(),
		listOp,
		model,
		query: { ...listOp.query, filterable: ["name"], searchable: [], selectable: [], sortable: ["name"] },
		records: [
			{ id: "1", name: "a" },
			{ id: "2", name: "b" },
			{ id: "3", name: "c" },
		],
	})
}

function plan(id: string, ctx: ReturnType<typeof context>) {
	const check = CHECKS.find((candidate) => candidate.id === id)
	if (check === undefined) throw new Error(`no check ${id}`)
	return check.plan(ctx)
}

const POSTGREST_HINT = "PostgREST-style filter expression: field.op.value"

describe("the reference template dialect", () => {
	it("hands an operator or direction it does not know to the canonical layer, which refuses it", () => {
		expect(toCanonicalFilter(["and_name_zz_x"], TEMPLATE)).toBe("name.zz.x")
		expect(toCanonicalFilter(["name_eq_x"], TEMPLATE)).toBeNull()
	})
})

describe("filter.illegal-op-rejected", () => {
	it("probes an operator token outside a declared grammar", () => {
		const ready = plan("filter.illegal-op-rejected", context({ grammar: FILTER }))
		expect(ready.ok).toBe(true)
		if (ready.ok) expect(JSON.stringify(ready.value)).toContain("and_name_zz_")
	})

	it("does not probe a grammar oat only inferred", () => {
		expect(plan("filter.illegal-op-rejected", context({}, POSTGREST_HINT)).ok).toBe(false)
	})
})

describe("sort.invalid-direction-rejected", () => {
	it("probes a direction token outside a declared grammar", () => {
		const ready = plan("sort.invalid-direction-rejected", context({ sortGrammar: SORT }))
		expect(ready.ok).toBe(true)
		if (ready.ok) expect(JSON.stringify(ready.value)).toContain("name_oatsideways")
	})

	it("stands down on an inferred grammar, and where ascending has no token of its own", () => {
		expect(plan("sort.invalid-direction-rejected", context({})).ok).toBe(false)
		expect(plan("sort.invalid-direction-rejected", context({ sortGrammar: "prefixed" })).ok).toBe(false)
	})
})

describe("filter.malformed-term-rejected", () => {
	it("sends a declared term with a required piece missing", () => {
		const ready = plan("filter.malformed-term-rejected", context({ grammar: FILTER }))
		expect(ready.ok).toBe(true)
		if (ready.ok) expect(JSON.stringify(ready.value)).toContain('"name_eq_')
		const postgrest = plan("filter.malformed-term-rejected", context({ grammar: "postgrest" }))
		expect(postgrest.ok).toBe(true)
		if (postgrest.ok) expect(JSON.stringify(postgrest.value)).toMatch(/"name\.[^".]+"/)
	})

	it("stands down on an inferred grammar", () => {
		expect(plan("filter.malformed-term-rejected", context({}, POSTGREST_HINT)).ok).toBe(false)
	})
})

describe("recall on the template dialect", () => {
	for (const defect of ["IGNORES_BAD_SORT_DIRECTION", "IGNORES_MALFORMED_FILTER"] as const) {
		it(`detects ${defect} and nothing else`, async () => {
			const result = await judgeDefect(defect, { backend: "memory", dialect: "template", via: listening })
			expect(result.error).toBeUndefined()
			expect(result.detected).toBe(true)
			expect(result.spurious.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
		})
	}
})
