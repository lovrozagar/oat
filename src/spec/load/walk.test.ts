import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../types.ts"
import { type Dereferencing, walk } from "./walk.ts"

function start(doc: Record<string, unknown>): Dereferencing {
	return {
		building: new Set(),
		defNames: new Map(),
		doc: doc as OpenApiDocument,
		externalRefs: new Set(),
		memo: new Map(),
	}
}

const walked = (doc: Record<string, unknown>) => {
	const state = start(doc)
	return { out: walk(state, doc) as Record<string, any>, state }
}

describe("walk", () => {
	it("passes scalars and null through", () => {
		const state = start({})
		expect(walk(state, 5)).toBe(5)
		expect(walk(state, null)).toBeNull()
	})

	it("resolves a node once, wherever it is reached, arrays included", () => {
		const shared = { type: "string" }
		const tags = ["a", "b"]
		const { out } = walked({ a: shared, b: shared, c: tags, d: tags })
		expect(out.a).toBe(out.b)
		expect(out.a).not.toBe(shared)
		expect(out.c).toBe(out.d)
		expect(out.c).toEqual(["a", "b"])
	})

	it("inlines an internal ref, and keeps an external one as it is, recording it", () => {
		const { out, state } = walked({ a: { type: "string" }, b: { $ref: "#/a" }, c: { $ref: "other.yaml#/X" } })
		expect(out.b).toEqual({ type: "string" })
		expect(out.c).toEqual({ $ref: "other.yaml#/X" })
		expect([...state.externalRefs]).toEqual(["other.yaml#/X"])
	})

	it("refuses a ref to nothing", () => {
		expect(() => walked({ a: { $ref: "#/missing" } })).toThrow("oat: unresolvable $ref #/missing")
	})
})

describe("walk refs", () => {
	it("lays a ref's siblings over its target, or over nothing when the target is not an object", () => {
		const { out } = walked({
			list: [1],
			obj: { type: "string" },
			text: "t",
			a: { $ref: "#/obj", description: "here" },
			b: { $ref: "#/text", description: "here" },
			c: { $ref: "#/list", description: "here" },
		})
		expect(out.a).toEqual({ description: "here", type: "string" })
		expect(out.obj).toEqual({ type: "string" })
		expect(out.b).toEqual({ description: "here" })
		expect(out.c).toEqual({ description: "here" })
	})

	it("turns a ref back into a node still being built into a ref into the definitions", () => {
		const { out, state } = walked({ a: { again: { $ref: "#/a" }, self: { $ref: "#/a" } }, list: [{ $ref: "#/list" }] })
		expect(out.a).toEqual({ again: { $ref: "oat-defs#/$defs/a" }, self: { $ref: "oat-defs#/$defs/a" } })
		expect(out.list).toEqual([{ $ref: "oat-defs#/$defs/list" }])
		expect([...state.defNames]).toEqual([
			["#/a", "a"],
			["#/list", "list"],
		])
	})

	it("gives two definitions that would share a name distinct names", () => {
		const { state } = walked({ a: { x: { $ref: "#/a" } }, b: { a: { y: { $ref: "#/b/a" } } } })
		expect([...state.defNames.values()]).toEqual(["a", "a_2"])
	})

	it("names a definition of the document itself, by `#` or `#/`", () => {
		expect([...walked({ s: { $ref: "#/" } }).state.defNames.values()]).toEqual(["schema"])
		expect([...walked({ s: { $ref: "#" } }).state.defNames.values()]).toEqual(["_"])
	})
})

describe("walk data", () => {
	it("copies data: an `example`, an `examples` array, and an Example Object's `value`", () => {
		const { out } = walked({
			target: { type: "string" },
			schema: {
				example: { $ref: "#/nowhere" },
				examples: [{ $ref: "#/nowhere" }],
				properties: { value: { $ref: "#/target" } },
			},
			param: {
				examples: {
					linked: { $ref: "#/target" },
					inline: { summary: { $ref: "#/target" }, value: { $ref: "#/nowhere" } },
				},
			},
			empty: { examples: null },
			text: { examples: "none" },
		})
		expect(out.schema).toEqual({
			example: { $ref: "#/nowhere" },
			examples: [{ $ref: "#/nowhere" }],
			properties: { value: { type: "string" } },
		})
		expect(out.param.examples).toEqual({
			inline: { summary: { type: "string" }, value: { $ref: "#/nowhere" } },
			linked: { type: "string" },
		})
		expect(out.empty).toEqual({ examples: null })
		expect(out.text).toEqual({ examples: "none" })
	})

	it("walks an Example Object afresh each time it is reached", () => {
		const one = { summary: "s", value: 1 }
		const { out } = walked({ p: { examples: { one } }, q: { examples: { one } } })
		expect(out.p.examples.one).toEqual(one)
		expect(out.p.examples.one).not.toBe(out.q.examples.one)
	})
})
