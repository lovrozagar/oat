import { describe, expect, it } from "vitest"
import { DEFS_ID } from "../../spec/load/defs.ts"
import { enumOf, unionOf, viaRef } from "./branches.ts"
import { instance } from "./instance.ts"
import type { At, Context } from "./types.ts"

const noRandomness = (): number => {
	throw new TypeError("no randomness")
}

const ctx = (fields: Partial<Context> = {}): Context => ({
	defs: {
		Leaf: { type: "string" },
		Node: { properties: { child: { $ref: `${DEFS_ID}#/$defs/Node` } }, type: "object" },
	},
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

const at = (fields: Partial<Context> = {}): At => ({ ctx: ctx(fields), distinct: false, pointer: "/v" })
const ref = (name: string): string => `${DEFS_ID}#/$defs/${name}`

describe("viaRef", () => {
	it("follows a ref into the document's defs, with its siblings merged in", () => {
		expect(viaRef({ $ref: ref("Leaf") }, at(), instance)).toBe("Quarterly Report 0")
		expect(viaRef({ $ref: ref("Leaf"), maxLength: 3 }, at(), instance)).toBe("Q 0")
	})

	it("refuses a ref it cannot follow", () => {
		expect(() => viaRef({ $ref: "#/components/schemas/Leaf" }, at(), instance)).toThrow(
			"cannot follow #/components/schemas/Leaf",
		)
		expect(() => viaRef({ $ref: ref("Missing") }, at(), instance)).toThrow(`cannot follow ${ref("Missing")}`)
	})

	it("bounds recursion through one schema", () => {
		expect(() => viaRef({ $ref: ref("Node") }, at({ refs: ["Node", "Node"] }), instance)).toThrow(
			"recursion through Node is bounded at depth 2",
		)
		/* The optional child is left out where the bound stops it. */
		expect(viaRef({ $ref: ref("Node") }, at(), instance)).toEqual({ child: {} })
	})
})

describe("unionOf", () => {
	it("is null under null-heavy when a branch allows it", () => {
		expect(
			unionOf({ oneOf: [{ type: "string" }, { type: "null" }] }, at({ variant: "null-heavy" }), instance),
		).toBeNull()
	})

	it("takes the first branch it can make, keeping the base", () => {
		const schema = { properties: { kind: { const: "k" } }, required: ["kind"] }
		const oneOf = [false, { properties: { a: { const: 1 } }, required: ["a"] }]
		expect(unionOf({ ...schema, oneOf }, at(), instance)).toEqual({ a: 1, kind: "k" })
	})

	it("is null when only the null branch is left, and refuses with every reason otherwise", () => {
		expect(unionOf({ oneOf: [false, { type: "null" }] }, at(), instance)).toBeNull()
		expect(() => unionOf({ oneOf: [false, { enum: [] }] }, at(), instance)).toThrow(
			"no branch of the union can be generated: the schema admits no value (false); the enum is empty",
		)
	})

	it("lets an error that is not about the schema through", () => {
		expect(() => unionOf({ oneOf: [{ type: "number" }] }, at({ rand: noRandomness }), instance)).toThrow(TypeError)
	})
})

describe("enumOf", () => {
	it("picks by index, and null under null-heavy when allowed", () => {
		expect(enumOf(["a", "b", "c"], ctx({ index: 4 }), "/e")).toBe("b")
		expect(enumOf(["a", null], ctx({ variant: "null-heavy" }), "/e")).toBeNull()
		expect(enumOf(["a", null], ctx(), "/e")).toBe("a")
	})

	it("is null for an enum of only null, and refuses an empty one", () => {
		expect(enumOf([null], ctx(), "/e")).toBeNull()
		expect(() => enumOf([], ctx(), "/e")).toThrow("the enum is empty")
	})
})
