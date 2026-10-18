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
		expect(() => instance({ type: "string" }, ctx({ depth: 13 }), "/deep", false)).toThrow(
			"the schema nests too deeply to generate",
		)
	})

	it("refuses false and a schema that is not an object, and makes text for any value", () => {
		expect(() => instance(false, ctx(), "", false)).toThrow("the schema admits no value (false)")
		expect(() => instance(5, ctx(), "", false)).toThrow("the schema is not an object")
		expect(instance(true, ctx(), "", false)).toBe("Quarterly Report 0")
		expect(instance({ description: "anything" }, ctx(), "", true)).toBe("Quarterly Report 0 n0")
	})

	it("follows refs, folds allOf, and returns a const", () => {
		expect(instance({ $ref: `${DEFS_ID}#/$defs/Leaf` }, ctx(), "", false)).toBe(true)
		expect(instance({ allOf: [{ type: "integer" }, { minimum: 7 }] }, ctx(), "", false)).toBe(8)
		expect(instance({ const: null }, ctx(), "", false)).toBeNull()
	})

	it("takes a union with branches, an enum, or the type", () => {
		expect(instance({ oneOf: [{ const: "one" }] }, ctx(), "", false)).toBe("one")
		expect(instance({ anyOf: [{ const: "any" }] }, ctx(), "", false)).toBe("any")
		expect(instance({ oneOf: [], type: "boolean" }, ctx(), "", false)).toBe(true)
		expect(instance({ enum: ["e"] }, ctx(), "", false)).toBe("e")
	})

	it("makes each type, null where null is all there is or the variant wants it", () => {
		expect(instance({ type: "string" }, ctx(), "", false)).toBe("Quarterly Report 0")
		expect(instance({ type: "integer" }, ctx(), "", false)).toBe(1)
		expect(instance({ type: "number" }, ctx(), "", false)).toBe(1.5)
		expect(instance({ type: "boolean" }, ctx({ index: 1 }), "", false)).toBe(false)
		expect(instance({ items: { type: "boolean" }, type: "array" }, ctx(), "", false)).toEqual([true])
		expect(instance({ properties: { a: { type: "boolean" } }, type: "object" }, ctx(), "", false)).toEqual({ a: true })
		expect(instance({ type: "null" }, ctx(), "", false)).toBeNull()
		expect(instance({ type: ["string", "null"] }, ctx({ variant: "null-heavy" }), "", false)).toBeNull()
		expect(instance({ type: ["null", "integer"] }, ctx(), "", false)).toBe(1)
	})

	it("refuses a type it does not know", () => {
		expect(() => instance({ type: "date" }, ctx(), "/d", false)).toThrow('unknown type "date"')
	})
})
