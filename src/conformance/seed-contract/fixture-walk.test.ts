import { describe, expect, it } from "vitest"
import { boundedPattern, FIXTURE_WALK, HANDLE_SCHEMA, runFixtureWalkCases } from "./fixture-walk.ts"

describe("runFixtureWalkCases", () => {
	it("walks every awkward schema to a fixture or a named gap", () => {
		const results = runFixtureWalkCases()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.name)).toEqual(FIXTURE_WALK.map((c) => c.name))
		expect(results.map((r) => r.detail).slice(1)).toEqual([
			"body returned",
			expect.stringMatching(/^[^@]+@[^@]+\.[^@]+$/),
			expect.stringMatching(/^\d+ variants$/),
			"body={} missing=/req",
			expect.stringContaining("table.create"),
		])
	})

	it("fails a case that throws with its message, and still runs the rest", () => {
		const results = runFixtureWalkCases([
			{
				name: "throws",
				probe: () => {
					throw new Error("walked off")
				},
				why: "a case can fail",
			},
			FIXTURE_WALK[0] as (typeof FIXTURE_WALK)[number],
		])
		expect(results.map((r) => [r.name, r.ok, r.detail.slice(0, 10)])).toEqual([
			["throws", false, "walked off"],
			["default: {} on a column object seeds", true, '{"columns"'],
		])
	})
})

describe("boundedPattern", () => {
	it("fails a cohort whose names fall short of three, showing every body", () => {
		const short = { maxLength: 2, minLength: 1, type: "string" }
		const verdict = boundedPattern({ ...HANDLE_SCHEMA, properties: { ...HANDLE_SCHEMA.properties, name: short } })
		expect(verdict.ok).toBe(false)
		expect(JSON.parse(verdict.detail)).toEqual(
			expect.arrayContaining([expect.objectContaining({ handle: expect.any(String) })]),
		)
	})
})
