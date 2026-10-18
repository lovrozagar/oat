import { describe, expect, it } from "vitest"
import { DEFS_ID } from "../../spec/load/defs.ts"
import { instance } from "./instance.ts"
import type { Context } from "./types.ts"

const ctx = (fields: Partial<Context> = {}): Context => ({
	defs: { Leaf: { type: "boolean" } },
	depth: 0,
	distinct: new Set(),
	index: 0,
	nonce: "n0",
	optional: "all",
	rand: () => 0.5,
	refs: [],
	variant: "baseline",
	...fields,
})

describe("instance", () => {
	it("stops past the depth bound", () => {
		expect(() => instance({ type: "string" }, { ctx: ctx({ depth: 13 }), distinct: false, pointer: "/deep" })).toThrow(
			"the schema nests too deeply to generate",
		)
	})

	it("refuses false and a schema that is not an object, and makes text for any value", () => {
		expect(() => instance(false, { ctx: ctx(), distinct: false, pointer: "" })).toThrow(
			"the schema admits no value (false)",
		)
		expect(() => instance(5, { ctx: ctx(), distinct: false, pointer: "" })).toThrow("the schema is not an object")
		expect(instance(true, { ctx: ctx(), distinct: false, pointer: "" })).toBe("Quarterly Report 0")
		expect(instance({ description: "anything" }, { ctx: ctx(), distinct: true, pointer: "" })).toBe(
			"Quarterly Report 0 n0",
		)
	})

	it("follows refs, folds allOf, and returns a const", () => {
		expect(instance({ $ref: `${DEFS_ID}#/$defs/Leaf` }, { ctx: ctx(), distinct: false, pointer: "" })).toBe(true)
		expect(
			instance({ allOf: [{ type: "integer" }, { minimum: 7 }] }, { ctx: ctx(), distinct: false, pointer: "" }),
		).toBe(8)
		expect(instance({ const: null }, { ctx: ctx(), distinct: false, pointer: "" })).toBeNull()
	})

	it("takes a union with branches, an enum, or the type", () => {
		expect(instance({ oneOf: [{ const: "one" }] }, { ctx: ctx(), distinct: false, pointer: "" })).toBe("one")
		expect(instance({ anyOf: [{ const: "any" }] }, { ctx: ctx(), distinct: false, pointer: "" })).toBe("any")
		expect(instance({ oneOf: [], type: "boolean" }, { ctx: ctx(), distinct: false, pointer: "" })).toBe(true)
		expect(instance({ enum: ["e"] }, { ctx: ctx(), distinct: false, pointer: "" })).toBe("e")
	})

	it("makes each type, null where null is all there is or the variant wants it", () => {
		expect(instance({ type: "string" }, { ctx: ctx(), distinct: false, pointer: "" })).toBe("Quarterly Report 0")
		expect(instance({ type: "integer" }, { ctx: ctx(), distinct: false, pointer: "" })).toBe(1)
		expect(instance({ type: "number" }, { ctx: ctx(), distinct: false, pointer: "" })).toBe(1.5)
		expect(instance({ type: "boolean" }, { ctx: ctx({ index: 1 }), distinct: false, pointer: "" })).toBe(false)
		expect(
			instance({ items: { type: "boolean" }, type: "array" }, { ctx: ctx(), distinct: false, pointer: "" }),
		).toEqual([true])
		expect(
			instance(
				{ properties: { a: { type: "boolean" } }, type: "object" },
				{ ctx: ctx(), distinct: false, pointer: "" },
			),
		).toEqual({ a: true })
		expect(instance({ type: "null" }, { ctx: ctx(), distinct: false, pointer: "" })).toBeNull()
		expect(
			instance({ type: ["string", "null"] }, { ctx: ctx({ variant: "null-heavy" }), distinct: false, pointer: "" }),
		).toBeNull()
		expect(instance({ type: ["null", "integer"] }, { ctx: ctx(), distinct: false, pointer: "" })).toBe(1)
	})

	it("refuses a type it does not know", () => {
		expect(() => instance({ type: "date" }, { ctx: ctx(), distinct: false, pointer: "/d" })).toThrow(
			'unknown type "date"',
		)
	})
})
