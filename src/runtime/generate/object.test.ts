import { describe, expect, it } from "vitest"
import { instance } from "./instance.ts"
import { objectFor } from "./object.ts"
import type { Context } from "./types.ts"

const noRandomness = (): number => {
	throw new TypeError("no randomness")
}

const ctx = (fields: Partial<Context> = {}): Context => ({
	defs: {},
	depth: 0,
	distinct: new Set(["name"]),
	index: 0,
	nonce: "n0",
	optional: "all",
	rand: () => 0.5,
	refs: [],
	variant: "baseline",
	...fields,
})

describe("objectFor", () => {
	it("makes every property, the top-level distinct ones with the nonce", () => {
		const schema = { properties: { name: { type: "string" }, note: { type: "string" } } }
		expect(objectFor(schema, { ctx: ctx(), distinct: false, pointer: "" }, instance)).toEqual({
			name: "Quarterly Report 0 n0",
			note: "Quarterly Report 0",
		})
		/* Below the top level a name is just a name. */
		expect(objectFor(schema, { ctx: ctx(), distinct: false, pointer: "/inner" }, instance)).toEqual({
			name: "Quarterly Report 0",
			note: "Quarterly Report 0",
		})
	})

	it("leaves optional properties out when asked to", () => {
		const schema = { properties: { a: { type: "boolean" }, b: { type: "boolean" } }, required: ["a"] }
		expect(objectFor(schema, { ctx: ctx({ optional: "none" }), distinct: false, pointer: "" }, instance)).toEqual({
			a: true,
		})
	})

	it("drops an optional property it cannot make, and refuses a required one", () => {
		const schema = { properties: { bad: false, good: { const: 1 } } }
		expect(objectFor(schema, { ctx: ctx(), distinct: false, pointer: "" }, instance)).toEqual({ good: 1 })
		expect(() =>
			objectFor({ ...schema, required: ["bad"] }, { ctx: ctx(), distinct: false, pointer: "" }, instance),
		).toThrow("admits no value")
	})

	it("escapes the property name in the pointer it reports", () => {
		expect(() =>
			objectFor(
				{ properties: { "a/b~c": false }, required: ["a/b~c"] },
				{ ctx: ctx(), distinct: false, pointer: "" },
				instance,
			),
		).toThrow(expect.objectContaining({ pointer: "/a~1b~0c" }))
	})

	it("gives a required but undescribed property any value", () => {
		expect(
			objectFor({ properties: [], required: ["x"] }, { ctx: ctx(), distinct: false, pointer: "" }, instance),
		).toEqual({ x: "Quarterly Report 0" })
	})

	it("lets an error that is not about the schema through, even on an optional property", () => {
		expect(() =>
			objectFor(
				{ properties: { n: { type: "number" } } },
				{ ctx: ctx({ rand: noRandomness }), distinct: false, pointer: "" },
				instance,
			),
		).toThrow(TypeError)
	})
})
