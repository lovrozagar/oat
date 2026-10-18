import { describe, expect, it } from "vitest"
import { distinctValue, outsideEnum, overMaxLength } from "./probes.ts"

describe("distinctValue", () => {
	it("changes a value to another valid one", () => {
		const schema = { enum: ["a", "b"], type: "string" }
		expect(distinctValue(schema, "a")).toEqual({ ok: true, value: "b" })
		expect(distinctValue({ const: "only" }, "only")).toMatchObject({ ok: false })
	})

	it("starts after the given index", () => {
		expect(distinctValue({ enum: ["a", "b", "c"] }, "a", { index: 1 })).toEqual({ ok: true, value: "c" })
	})

	it("passes on why a schema admits nothing", () => {
		expect(distinctValue(false, "a")).toEqual({ ok: false, pointer: "/", reason: "the schema admits no value (false)" })
	})
})

describe("outsideEnum", () => {
	it("needs an enum", () => {
		expect(outsideEnum({ type: "string" })).toMatchObject({ ok: false, reason: "no enum declared" })
		expect(outsideEnum(null)).toMatchObject({ ok: false })
	})

	it("goes one past the largest number, or picks text the enum lacks", () => {
		expect(outsideEnum({ enum: [1, 5, 3] })).toEqual({ ok: true, value: 6 })
		expect(outsideEnum({ enum: ["a"] })).toEqual({ ok: true, value: "oat-not-in-enum" })
		expect(outsideEnum({ enum: ["oat-not-in-enum", "oat-not-in-enum-x"] })).toEqual({
			ok: true,
			value: "oat-not-in-enum-x-x",
		})
	})
})

describe("overMaxLength", () => {
	it("is one past maxLength, or says there is none", () => {
		expect(overMaxLength({ maxLength: 3 })).toEqual({ ok: true, value: "xxxx" })
		expect(overMaxLength({ type: "string" })).toMatchObject({ ok: false, reason: "no maxLength declared" })
		expect(overMaxLength(7)).toMatchObject({ ok: false })
	})
})
