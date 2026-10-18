import { describe, expect, it } from "vitest"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/runtime/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { parseFilterGrammar } from "../../src/spec/filter-render.ts"
import { buildModel } from "../../src/spec/graph.ts"
import { dereference } from "../../src/spec/load.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"

/*
 * What a `like` value means is declared, not assumed. Under `pattern`, `%` and `_` are wildcards,
 * so a bare `%` matching everything is the grammar working; under `contains` the value is a plain
 * substring and a bare `%` must match only values holding one. The escaping check sends exactly
 * that `%`, so it can only judge a grammar that reads it literally.
 */

const TEMPLATE = { conj: { and: "and" }, ops: { eq: "eq", like: "like" }, term: "{conj}_{field}_{op}_{value}" }

function planFor(grammar: Record<string, unknown>) {
	const doc = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "notes.list",
					parameters: [{ in: "query", name: "filter", schema: { type: "string" } }],
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
					"x-query": { filterable: ["name"], grammar, searchable: ["name"] },
				},
			},
		},
	} as unknown as OpenApiDocument
	const model = buildModel(dereference(doc).doc)
	const listOp = model.byOperationId.get("notes.list")
	const check = CHECKS.find((candidate) => candidate.id === "filter.like-metacharacters-escaped")
	if (listOp === undefined || check === undefined || listOp.query === null) throw new Error("fixture incomplete")
	const ctx = checkContext({
		client: new Client("http://127.0.0.1:1"),
		entityName: "note",
		findings: new FindingCollector(),
		listOp,
		model,
		query: { ...listOp.query, filterable: ["name"], searchable: ["name"], selectable: [], sortable: [] },
		records: [
			{ id: "1", name: "a" },
			{ id: "2", name: "b" },
		],
	})
	return check.plan(ctx)
}

function wildcardOf(raw: Record<string, unknown>) {
	const parsed = parseFilterGrammar(raw)
	if (!parsed.ok) throw new Error(parsed.error)
	return parsed.spec.likeWildcard
}

describe("likeMatches", () => {
	it("is a pattern unless declared a substring", () => {
		expect(wildcardOf(TEMPLATE)).toBe("%")
		expect(wildcardOf({ ...TEMPLATE, likeMatches: "contains" })).toBeNull()
	})

	it("keeps the escaping check off a grammar where % is a wildcard", () => {
		expect(planFor(TEMPLATE).ok).toBe(false)
	})

	it("runs the escaping check where the value is a plain substring", () => {
		expect(planFor({ ...TEMPLATE, likeMatches: "contains" }).ok).toBe(true)
	})
})
