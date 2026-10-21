import { describe, expect, it } from "vitest"
import { invalidated, invalidChoice, wrongTyped } from "./invalid-body.ts"

describe("invalidChoice", () => {
	it("prefers removing the first required property, in the required array's order", () => {
		const schema = {
			properties: { name: { type: "string" }, size: { type: "integer" } },
			required: ["size", "name"],
			type: "object",
		}
		expect(invalidChoice(schema)).toEqual({ field: "size", kind: "missing" })
	})

	it("never removes a property from a PATCH, which merges and need not resend it: it sends the wrong type", () => {
		const schema = { properties: { size: { type: "integer" } }, required: ["size"], type: "object" }
		expect(invalidChoice(schema, { merge: true })).toEqual({ field: "size", kind: "wrong-type", value: "oat-invalid" })
		expect(invalidChoice(schema, { merge: false })).toEqual({ field: "size", kind: "missing" })
	})
})

describe("invalidChoice: what it never breaks", () => {
	it("never breaks a property the path already names: the record's identity, or a path parameter", () => {
		const schema = {
			properties: { id: { type: "string" }, project_id: { type: "string" }, title: { type: "string" } },
			required: ["id", "project_id", "title"],
			type: "object",
		}
		const kept = new Set(["id", "project_id"])
		expect(invalidChoice(schema, { kept })).toEqual({ field: "title", kind: "missing" })
		const identityOnly = { ...schema, required: ["id"] }
		expect(invalidChoice(identityOnly, { kept })).toEqual({ field: "title", kind: "wrong-type", value: 7 })
		expect(invalidChoice({ properties: { id: { type: "string" } }, required: ["id"] }, { kept })).toBeNull()
		const serverSet = {
			properties: { stamp: { readOnly: true, type: "string" }, title: { type: "string" } },
			required: ["stamp"],
		}
		expect(invalidChoice(serverSet, { kept })).toEqual({ field: "title", kind: "wrong-type", value: 7 })
	})

	it("never removes a property no writer sends: readOnly, or an optional x-privileged one", () => {
		const schema = {
			properties: {
				id: { readOnly: true, type: "string" },
				name: { type: "string" },
				verified: { type: "boolean", "x-privileged": true },
			},
			required: ["id"],
			type: "object",
		}
		expect(invalidChoice(schema)).toEqual({ field: "name", kind: "wrong-type", value: 7 })
	})

	it("without a required property, sends the first typed property, in document order, a value of another type", () => {
		const schema = {
			properties: { anything: {}, count: { type: "integer" }, name: { type: "string" } },
			type: "object",
		}
		expect(invalidChoice(schema)).toEqual({ field: "count", kind: "wrong-type", value: "oat-invalid" })
	})

	it("chooses the same body every time: the choice reads the schema alone", () => {
		const schema = { properties: { b: { type: "boolean" }, a: { type: "string" } }, type: "object" }
		expect(invalidChoice(schema)).toEqual(invalidChoice(structuredClone(schema)))
		expect(invalidChoice(schema)).toEqual({ field: "b", kind: "wrong-type", value: 7 })
	})

	it("is null for a schema with nothing to break: no properties, or none typed", () => {
		expect(invalidChoice({ type: "object" })).toBeNull()
		expect(invalidChoice({ properties: { anything: {} }, type: "object" })).toBeNull()
		expect(invalidChoice(true)).toBeNull()
	})
})

describe("wrongTyped", () => {
	it("is a value no listed type admits, null never among them", () => {
		expect(wrongTyped("string")).toBe(7)
		expect(wrongTyped(["string", "null"])).toBe(7)
		expect(wrongTyped("number")).toBe("oat-invalid")
		expect(wrongTyped(["string", "integer"])).toBe(true)
		expect(wrongTyped(["string", "number", "boolean"])).toEqual([])
		expect(wrongTyped(["string", "number", "boolean", "array"])).toEqual({})
	})

	it("is undefined when every type is admitted, or no type is stated", () => {
		expect(wrongTyped(["string", "number", "boolean", "array", "object"])).toBeUndefined()
		expect(wrongTyped(undefined)).toBeUndefined()
		expect(wrongTyped(42)).toBeUndefined()
	})
})

describe("invalidated", () => {
	it("drops the missing property, and leaves the rest of the body as it was", () => {
		const base = { name: "n", size: 3 }
		expect(invalidated(base, { field: "size", kind: "missing" })).toEqual({ name: "n" })
		expect(base).toEqual({ name: "n", size: 3 })
	})

	it("sets the wrong-typed property, whether or not the body held it", () => {
		expect(invalidated({ name: "n" }, { field: "name", kind: "wrong-type", value: 7 })).toEqual({ name: 7 })
		expect(invalidated({}, { field: "count", kind: "wrong-type", value: "x" })).toEqual({ count: "x" })
	})
})
