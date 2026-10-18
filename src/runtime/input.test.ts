import { describe, expect, it } from "vitest"
import { applyResolveInput } from "./input.ts"
import { encodeRequest } from "./body/encode.ts"
import type { InputRequest } from "../config/types/hooks.ts"

describe("resolveInput", () => {
	it("leaves the generator alone when the hook is omitted", async () => {
		const fields = { name: "Quarterly Report 0" }
		expect(
			await applyResolveInput(fields, undefined, {
				operationId: "billing.subscribe",
				schema: { properties: { name: { type: "string" } } },
			}),
		).toEqual(fields)
	})

	it("replaces a named field and keeps the rest", async () => {
		const asked: InputRequest[] = []
		const out = await applyResolveInput(
			{ name: "plan", payment_method_id: "generated" },
			async (request) => {
				asked.push(request)
				return request.field === "payment_method_id" ? "pm_test_123" : null
			},
			{
				operationId: "billing.subscribe",
				schema: {
					properties: {
						name: { type: "string" },
						payment_method_id: { type: "string" },
					},
				},
			},
		)
		expect(out).toEqual({ name: "plan", payment_method_id: "pm_test_123" })
		expect(asked.map(({ field, operationId, pointer, value }) => [field, operationId, pointer, value])).toEqual([
			["name", "billing.subscribe", "$.name", "plan"],
			["payment_method_id", "billing.subscribe", "$.payment_method_id", "generated"],
		])
	})

	it("walks nested objects and skips arrays", async () => {
		const out = await applyResolveInput(
			{ card: { brand: "visa" }, tags: ["a"] },
			async ({ pointer }) => (pointer === "$.card.brand" ? "amex" : null),
			{
				operationId: "pay.create",
				schema: {
					properties: {
						card: { properties: { brand: { type: "string" } }, type: "object" },
						tags: { type: "array" },
					},
				},
			},
		)
		expect(out).toEqual({ card: { brand: "amex" }, tags: ["a"] })
	})
})

describe("resolveInput on fields the body lacks or keeps", () => {
	it("still visits fields that exist only on the schema", async () => {
		const out = await applyResolveInput(
			{},
			async ({ field, value }) => {
				expect(value).toBeUndefined()
				return field === "payment_method_id" ? "pm_only_schema" : null
			},
			{ operationId: "billing.subscribe", schema: { properties: { payment_method_id: { type: "string" } } } },
		)
		expect(out.payment_method_id).toBe("pm_only_schema")
	})

	it("passes an oversized value through when the hook returns null", async () => {
		const over = "x".repeat(65)
		const out = await applyResolveInput(
			{ category: over },
			async ({ value }) => (value === undefined || (typeof value === "string" && value.length > 64) ? null : "general"),
			{ operationId: "tableTemplate.create", schema: { properties: { category: { maxLength: 64, type: "string" } } } },
		)
		expect(out.category).toBe(over)
	})

	it("leaves an omitted field omitted when the hook returns null", async () => {
		const asked: InputRequest[] = []
		const out = await applyResolveInput(
			{ name: "Quarterly Report 0" },
			async (request) => {
				asked.push(request)
				return null
			},
			{
				operationId: "table.create",
				schema: { properties: { columns_json: { type: "array" }, name: { type: "string" } } },
			},
		)
		expect(out).toEqual({ name: "Quarterly Report 0" })
		expect(asked.map(({ field, value }) => [field, value])).toEqual([
			["name", "Quarterly Report 0"],
			["columns_json", undefined],
		])
		expect("columns_json" in out).toBe(false)
	})
})

describe("resolveInput through encode and odd schemas", () => {
	it("applies during JSON encode", async () => {
		const encoded = await encodeRequest({
			fields: { payment_method_id: "nope" },
			index: 0,
			mediaType: "application/json",
			operationId: "billing.subscribe",
			schema: { properties: { payment_method_id: { type: "string" } }, type: "object" },
			uploads: {
				resolveInput: async ({ field }) => (field === "payment_method_id" ? "pm_enc" : null),
				seed: 1,
			},
			variant: "baseline",
		})
		expect(encoded.body).toEqual({ payment_method_id: "pm_enc" })
	})

	it("treats a non-object schema as empty properties", async () => {
		const out = await applyResolveInput({ a: 1 }, async () => null, { operationId: "op", schema: undefined })
		expect(out).toEqual({ a: 1 })
		expect(
			await applyResolveInput({ a: 1 }, async () => null, { operationId: "op", schema: { properties: null } as never }),
		).toEqual({ a: 1 })
	})

	it("does not walk a scalar child", async () => {
		const out = await applyResolveInput({ n: 3 }, async () => null, {
			operationId: "op",
			schema: { properties: { n: { type: "number" } } },
		})
		expect(out).toEqual({ n: 3 })
	})

	it("treats a null child schema as empty", async () => {
		const out = await applyResolveInput({ nested: { a: 1 } }, async () => null, {
			operationId: "op",
			schema: { properties: { nested: null } } as never,
		})
		expect(out).toEqual({ nested: { a: 1 } })
	})

	it("treats a non-object schema argument as empty properties", async () => {
		expect(await applyResolveInput({ a: 1 }, async () => null, { operationId: "op", schema: "nope" as never })).toEqual(
			{ a: 1 },
		)
	})
})
