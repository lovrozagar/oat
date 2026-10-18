import { describe, expect, it } from "vitest"
import { list, member, ok, query } from "../__fixtures__/documents.ts"
import { modelOf, operation } from "./__fixtures__/operations.ts"
import { documentedPage, largestPageQuery } from "./paging.ts"

const listing = (parameters: unknown[], xQuery?: Record<string, unknown>) =>
	modelOf({
		"/notes": {
			get: {
				operationId: "notes.list",
				parameters,
				responses: ok(list(member)),
				...(xQuery === undefined ? {} : { "x-query": xQuery }),
			},
		},
	})

const pageOf = (parameters: unknown[], xQuery?: Record<string, unknown>) => {
	const model = listing(parameters, xQuery)
	const op = model.byOperationId.get("notes.list")
	if (op === undefined) throw new Error("notes.list is missing")
	return { model, op }
}

describe("documentedPage", () => {
	it("takes x-query's maxLimit first", () => {
		const { model, op } = pageOf([query("limit", { maximum: 50, type: "integer" })], { maxLimit: 20 })
		expect(documentedPage(model, op)).toEqual({ param: "limit", size: 20 })
	})

	it("then the page-size parameter's maximum, else a conventional 100", () => {
		const bounded = pageOf([query("limit", { maximum: 50, type: "integer" })])
		expect(documentedPage(bounded.model, bounded.op)).toEqual({ param: "limit", size: 50 })
		const below = pageOf([query("limit", { maximum: 0, type: "integer" })])
		expect(documentedPage(below.model, below.op).size).toBe(100)
		const unbounded = pageOf([{ $ref: "other.yaml#/Limit" }, query("limit", { type: "integer" })])
		expect(documentedPage(unbounded.model, unbounded.op)).toEqual({ param: "limit", size: 100 })
	})

	it("has no parameter for an operation without a page size, or one the model does not hold", () => {
		const { model, op } = pageOf([])
		expect(documentedPage(model, op)).toEqual({ param: undefined, size: 100 })
		const stranger = operation({ conventions: { ...op.conventions, limit: "limit" }, operationId: "elsewhere" })
		expect(documentedPage(model, stranger)).toEqual({ param: "limit", size: 100 })
	})
})

describe("largestPageQuery", () => {
	it("asks for the largest page, or nothing when there is no page size to ask with", () => {
		const bounded = pageOf([query("per_page", { maximum: 30, type: "integer" })])
		expect(largestPageQuery(bounded.model, bounded.op)).toEqual({ per_page: 30 })
		const none = pageOf([])
		expect(largestPageQuery(none.model, none.op)).toEqual({})
	})
})
