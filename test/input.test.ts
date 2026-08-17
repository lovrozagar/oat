import { describe, expect, it } from "vitest"
import { applyResolveInput } from "../src/runtime/input.ts"
import { encodeRequest } from "../src/runtime/body.ts"

describe("resolveInput", () => {
	it("leaves the generator alone when the hook is omitted", async () => {
		const fields = { name: "Quarterly Report 0" }
		expect(
			await applyResolveInput(fields, "billing.subscribe", { properties: { name: { type: "string" } } }, undefined),
		).toEqual(fields)
	})

	it("replaces a named field and keeps the rest", async () => {
		const out = await applyResolveInput(
			{ name: "plan", payment_method_id: "generated" },
			"billing.subscribe",
			{
				properties: {
					name: { type: "string" },
					payment_method_id: { type: "string" },
				},
			},
			async ({ operationId, field, pointer }) => {
				if (operationId === "billing.subscribe" && field === "payment_method_id") {
					expect(pointer).toBe("$.payment_method_id")
					return "pm_test_123"
				}
				return null
			},
		)
		expect(out).toEqual({ name: "plan", payment_method_id: "pm_test_123" })
	})

	it("walks nested objects and skips arrays", async () => {
		const out = await applyResolveInput(
			{ card: { brand: "visa" }, tags: ["a"] },
			"pay.create",
			{
				properties: {
					card: { properties: { brand: { type: "string" } }, type: "object" },
					tags: { type: "array" },
				},
			},
			async ({ pointer }) => (pointer === "$.card.brand" ? "amex" : null),
		)
		expect(out).toEqual({ card: { brand: "amex" }, tags: ["a"] })
	})

	it("still visits fields that exist only on the schema", async () => {
		const out = await applyResolveInput(
			{},
			"billing.subscribe",
			{ properties: { payment_method_id: { type: "string" } } },
			async ({ field }) => (field === "payment_method_id" ? "pm_only_schema" : null),
		)
		expect(out.payment_method_id).toBe("pm_only_schema")
	})

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
		const out = await applyResolveInput({ a: 1 }, "op", undefined, async () => null)
		expect(out).toEqual({ a: 1 })
		expect(await applyResolveInput({ a: 1 }, "op", { properties: null } as never, async () => null)).toEqual({ a: 1 })
	})

	it("does not walk a scalar child", async () => {
		const out = await applyResolveInput({ n: 3 }, "op", { properties: { n: { type: "number" } } }, async () => null)
		expect(out).toEqual({ n: 3 })
	})

	it("treats a null child schema as empty", async () => {
		const out = await applyResolveInput(
			{ nested: { a: 1 } },
			"op",
			{ properties: { nested: null } } as never,
			async () => null,
		)
		expect(out).toEqual({ nested: { a: 1 } })
	})

	it("treats a non-object schema argument as empty properties", async () => {
		expect(await applyResolveInput({ a: 1 }, "op", "nope" as never, async () => null)).toEqual({ a: 1 })
	})
})
