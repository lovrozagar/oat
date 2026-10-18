import { describe, expect, it } from "vitest"
import { createBodyPlan, findConstrained } from "./bodies.ts"
import { itemsDocument, stage } from "./__fixtures__/items.ts"

const hasEnum = (s: Record<string, unknown>) => Array.isArray(s.enum)

describe("createBodyPlan", () => {
	it("needs nothing it can name when the entity has no create", () => {
		const { ctx } = stage(itemsDocument({ type: "object" }), { status: 201 }, { createOp: undefined })
		expect(createBodyPlan(ctx)).toEqual({ needs: undefined, ok: false })
	})

	it("needs a request schema when the create takes no body", () => {
		const { ctx } = stage(itemsDocument(null), { status: 201 })
		expect(createBodyPlan(ctx)).toEqual({ needs: "a create operation with a request schema", ok: false })
	})

	it("hands the create and its request schema to the run", () => {
		const schema = { properties: { name: { type: "string" } }, type: "object" }
		const { ctx } = stage(itemsDocument(schema), { status: 201 })
		const plan = createBodyPlan(ctx)
		expect(plan.ok && plan.value.createOp.operationId).toBe("item.create")
		expect(plan.ok && plan.value.schema).toEqual(schema)
	})
})

describe("findConstrained", () => {
	it("finds nothing in a schema without an object of properties", () => {
		expect(findConstrained({}, hasEnum)).toBeNull()
		expect(findConstrained({ properties: null }, hasEnum)).toBeNull()
		expect(findConstrained({ properties: "name" }, hasEnum)).toBeNull()
	})

	it("passes over malformed and read-only properties", () => {
		const schema = { properties: { broken: null, server: { enum: ["a"], readOnly: true }, word: "x" } }
		expect(findConstrained(schema, hasEnum)).toBeNull()
	})

	it("returns the first writable property the predicate accepts", () => {
		const status = { enum: ["open"], type: "string" }
		expect(findConstrained({ properties: { name: { type: "string" }, status } }, hasEnum)).toEqual({
			name: "status",
			schema: status,
		})
	})

	it("returns the union branch that carries the constraint, from oneOf or anyOf", () => {
		const branch = { enum: [1, 2], type: "integer" }
		expect(
			findConstrained({ properties: { level: { oneOf: [null, "x", { type: "null" }, branch] } } }, hasEnum),
		).toEqual({ name: "level", schema: branch })
		expect(findConstrained({ properties: { level: { anyOf: [branch] } } }, hasEnum)).toEqual({
			name: "level",
			schema: branch,
		})
	})

	it("keeps looking past a union with no constrained branch, or a union that is not a list", () => {
		const later = { enum: ["b"] }
		const schema = { properties: { a: { oneOf: [{ type: "string" }] }, b: { anyOf: "x" }, c: later } }
		expect(findConstrained(schema, hasEnum)).toEqual({ name: "c", schema: later })
	})
})
