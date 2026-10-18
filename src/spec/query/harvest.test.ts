import { describe, expect, it } from "vitest"
import { applyHarvest } from "./harvest.ts"
import { emptyCapabilities } from "./merge.ts"

const caps = {
	...emptyCapabilities(),
	filterable: [{ field: "id" }],
	filterableFrom: { path: "$.n", typeMap: { int: "number" as const } },
	sortableFrom: { path: "$.n", typeMap: { int: "number" as const } },
	source: "tag" as const,
}

describe("harvest", () => {
	it("adds names to searchable and selectable, without empty ones", () => {
		expect(applyHarvest(caps, { axis: "searchable", names: ["", "alpha"], types: ["string"] }).searchable).toEqual([
			"alpha",
		])
		expect(applyHarvest(caps, { axis: "selectable", names: ["id"], types: [] }).selectable).toEqual(["id"])
	})

	it("adds sortable rows, typed through the map or as a known type", () => {
		expect(
			applyHarvest(caps, { axis: "sortable", names: ["n", "s", "x", "u"], types: ["int", "string", "nope"] }).sortable,
		).toEqual([{ field: "n", type: "number" }, { field: "s", type: "string" }, { field: "x" }, { field: "u" }])
		/* A repeated name takes the type at its first place. */
		expect(applyHarvest(caps, { axis: "sortable", names: ["n", "n"], types: ["int", "string"] }).sortable).toEqual([
			{ field: "n", type: "number" },
		])
		expect(
			applyHarvest({ ...caps, sortableFrom: { path: "$" } }, { axis: "sortable", names: ["s"], types: ["int"] })
				.sortable,
		).toEqual([{ field: "s" }])
	})

	it("adds filterable rows by default, typed by position", () => {
		expect(applyHarvest(caps, { axis: "filterable", names: ["n"], types: ["int"] }).filterable).toEqual([
			{ field: "id" },
			{ field: "n", type: "number" },
		])
		expect(applyHarvest(caps, { names: ["x"], types: ["nope"] }).filterable).toEqual([{ field: "id" }, { field: "x" }])
		expect(applyHarvest(caps, { names: ["id", "y"], types: ["string", "string"] }).filterable).toEqual([
			{ field: "id", type: "string" },
			{ field: "y", type: "string" },
		])
		expect(applyHarvest(caps, { names: ["z"] }).filterable).toEqual([{ field: "id" }, { field: "z" }])
		expect(applyHarvest(emptyCapabilities(), { names: ["q"], types: ["string"] }).filterable).toEqual([
			{ field: "q", type: "string" },
		])
	})
})
