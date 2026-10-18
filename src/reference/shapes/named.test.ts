import { describe, expect, it } from "vitest"
import { SHAPES } from "./catalog.ts"
import { shapeNamed } from "./named.ts"

describe("shapeNamed", () => {
	it("finds a shape by its name", () => {
		expect(shapeNamed("uuid-ids")).toBe(SHAPES.find((shape) => shape.name === "uuid-ids"))
		expect(shapeNamed("clamped-limit").shape).toEqual({ clampLimit: 3 })
	})

	it("refuses a name no shape has, listing the ones there are", () => {
		expect(() => shapeNamed("nope")).toThrow(/^unknown shape "nope" — expected one of page-total, cursor-only, /)
	})
})
