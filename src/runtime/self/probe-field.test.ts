import { describe, expect, it } from "vitest"
import { nextValue, probeField } from "./probe-field.ts"

const object = (properties: Record<string, unknown>): Record<string, unknown> => ({ properties, type: "object" })

describe("probeField", () => {
	it("needs an object schema with properties", () => {
		expect(probeField(undefined)).toBeNull()
		expect(probeField([])).toBeNull()
		expect(probeField({ type: "object" })).toBeNull()
		expect(probeField({ properties: null })).toBeNull()
	})

	it("prefers a known name field, then the rest in order", () => {
		expect(probeField(object({ bio: { type: "string" }, nickname: { type: "string" } }))?.name).toBe("nickname")
		expect(probeField(object({ bio: { type: "string" } }))).toEqual({ kind: "string", maxLength: 64, name: "bio" })
	})

	it("skips fields it cannot set and read back, keeping a boolean as the fallback", () => {
		const schema = object({
			code: { pattern: "^[a-z]+$", type: "string" },
			email: { format: "email", type: "string" },
			flag: { type: "boolean" },
			id: { readOnly: true, type: "string" },
			kind: { enum: ["a"], type: "string" },
			link: { format: "uri", type: "string" },
			notes: true,
			other: { type: "boolean" },
			seen: { format: "date-time", type: "string" },
			short: { maxLength: 3, type: "string" },
			size: { type: "integer" },
		})
		expect(probeField(schema)).toEqual({ kind: "boolean", maxLength: 0, name: "flag" })
		expect(probeField(object({ size: { type: "integer" } }))).toBeNull()
	})

	it("sees through a nullable union and a nullable type", () => {
		expect(probeField(object({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }))?.name).toBe("a")
		expect(probeField(object({ a: { oneOf: [{ type: "null" }, { maxLength: 9, type: "string" }] } }))).toEqual({
			kind: "string",
			maxLength: 9,
			name: "a",
		})
		expect(probeField(object({ a: { type: ["string", "null"] } }))?.name).toBe("a")
		expect(probeField(object({ a: { anyOf: [{ type: "string" }, { type: "integer" }] } }))).toBeNull()
		expect(probeField(object({ a: { anyOf: ["x", { type: "null" }] } }))).toBeNull()
		expect(probeField(object({ a: { type: ["string", "integer"] } }))).toBeNull()
		expect(
			probeField({ anyOf: [{ properties: { a: { type: "string" } }, type: "object" }, { type: "null" }] })?.name,
		).toBe("a")
	})
})

describe("probeField and the fields it must leave alone", () => {
	it("never picks one of them, falling back to the next field or nothing", () => {
		const schema = {
			properties: { dismissed: { type: "boolean" }, name: { type: "string" }, password: { type: "string" } },
			type: "object",
		}
		expect(probeField(schema, new Set(["name"]))).toEqual({ kind: "string", maxLength: 64, name: "password" })
		expect(probeField(schema, new Set(["name", "password"]))).toEqual({
			kind: "boolean",
			maxLength: 0,
			name: "dismissed",
		})
		expect(probeField(schema, new Set(["name", "password", "dismissed"]))).toBeNull()
	})
})

describe("nextValue", () => {
	it("flips a boolean and alternates between two short strings", () => {
		expect(nextValue({ kind: "boolean", maxLength: 0, name: "f" }, true)).toBe(false)
		expect(nextValue({ kind: "boolean", maxLength: 0, name: "f" }, undefined)).toBe(true)
		expect(nextValue({ kind: "string", maxLength: 64, name: "n" }, "Bob")).toBe("Oat")
		expect(nextValue({ kind: "string", maxLength: 64, name: "n" }, "Oat")).toBe("Xot")
		expect(nextValue({ kind: "string", maxLength: 2, name: "n" }, "x")).toBe("Oa")
	})
})

describe("probeField under a guard pattern on every string", () => {
	const guard = "^[^\\u0000\\uD800-\\uDFFF]*$"
	const phone = {
		anyOf: [
			{ allOf: [{ pattern: "^\\+[1-9]\\d{7,14}$" }, { pattern: guard }], maxLength: 15, minLength: 7, type: "string" },
			{ type: "null" },
		],
	}

	it("takes a field whose pattern admits both probe values", () => {
		expect(probeField(object({ display_name: { maxLength: 64, pattern: guard, type: "string" } }))).toEqual({
			kind: "string",
			maxLength: 64,
			name: "display_name",
		})
	})

	it("skips a field whose own pattern or minLength, in or beside an allOf, refuses the probe values", () => {
		expect(probeField(object({ phone_number: phone }))).toBeNull()
		expect(probeField(object({ password: { minLength: 8, type: "string" } }))).toBeNull()
		expect(probeField(object({ phone_number: phone, first_name: { pattern: guard, type: "string" } }))?.name).toBe(
			"first_name",
		)
	})
})
