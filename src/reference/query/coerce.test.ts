import { describe, expect, it } from "vitest"
import type { FieldDef } from "../model/types.ts"
import { coerce } from "./coerce.ts"

const of = (type: FieldDef["type"]): FieldDef => ({ name: "f", type })

describe("coerce", () => {
	it("reads an integer field's text as a whole number, and nothing else as one", () => {
		expect(coerce("2", of("integer"))).toBe(2)
		expect(coerce("-3", of("integer"))).toBe(-3)
		for (const raw of ["", "  ", "abc", "Infinity", "2.5"]) expect(coerce(raw, of("integer"))).toBeUndefined()
	})

	it("reads a number field's text as any finite number", () => {
		expect(coerce("2.5", of("number"))).toBe(2.5)
		expect(coerce("1e3", of("number"))).toBe(1000)
		expect(coerce("NaN", of("number"))).toBeUndefined()
	})

	it("reads only true and false for a boolean", () => {
		expect(coerce("true", of("boolean"))).toBe(true)
		expect(coerce("false", of("boolean"))).toBe(false)
		expect(coerce("TRUE", of("boolean"))).toBeUndefined()
	})

	it("keeps text as text, whatever it looks like", () => {
		expect(coerce("123", of("string"))).toBe("123")
		expect(coerce("", of("string"))).toBe("")
	})
})
