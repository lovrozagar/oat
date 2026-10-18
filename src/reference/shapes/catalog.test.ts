import { describe, expect, it } from "vitest"
import { isDefectName } from "../defects/table.ts"
import { SHAPES } from "./catalog.ts"

describe("SHAPES", () => {
	it("names each shape once and says what a correct backend does differently there", () => {
		const names = SHAPES.map((shape) => shape.name)
		expect(new Set(names).size).toBe(names.length)
		for (const shape of SHAPES) expect(shape.why.length).toBeGreaterThan(10)
	})

	it("names only real defects as ones a shape cannot show or alone can", () => {
		const named = SHAPES.flatMap((shape) => [...(shape.cannotExhibit ?? []), ...(shape.exhibits ?? [])])
		expect(named.length).toBeGreaterThan(0)
		expect(named.filter((name) => !isDefectName(name))).toEqual([])
	})

	it("gives a reason for every check a shape cannot run", () => {
		const reasons = SHAPES.flatMap((shape) => Object.entries(shape.cannotRun ?? {}))
		expect(reasons.length).toBeGreaterThan(0)
		for (const [check, reason] of reasons) {
			expect(check).toMatch(/^[a-z-]+\.[a-z-]+$/)
			expect(reason.length).toBeGreaterThan(5)
		}
	})
})
