import { describe, expect, it } from "vitest"
import { FILTER_PRESETS } from "./filter-presets.ts"

describe("filter presets", () => {
	it("give postgrest every operator but is, in catalog order, and colon the ops 0.7.0 wrote", () => {
		expect(Object.keys(FILTER_PRESETS.postgrest.ops)).toEqual([
			"eq",
			"ne",
			"neq",
			"gt",
			"gte",
			"lt",
			"lte",
			"in",
			"nin",
			"like",
			"ilike",
			"contains",
		])
		expect(
			Object.values(FILTER_PRESETS.postgrest.ops).every(
				(token, index) => token === Object.keys(FILTER_PRESETS.postgrest.ops)[index],
			),
		).toBe(true)
		expect(FILTER_PRESETS.colon.ops).toEqual({
			eq: "eq",
			gt: "gt",
			gte: "gte",
			like: "like",
			lt: "lt",
			lte: "lte",
			neq: "neq",
		})
		expect(FILTER_PRESETS.equality.ops).toEqual({ eq: "eq" })
		expect(FILTER_PRESETS.unrecognised.ops).toEqual({})
	})

	it("let only postgrest nest and and or", () => {
		expect(
			Object.entries(FILTER_PRESETS)
				.filter(([, spec]) => spec.mixed)
				.map(([name]) => name),
		).toEqual(["postgrest"])
	})
})
