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
		expect(applyHarvest(caps, ["", "alpha"], ["string"], "searchable").searchable).toEqual(["alpha"])
		expect(applyHarvest(caps, ["id"], [], "selectable").selectable).toEqual(["id"])
	})

	it("adds sortable rows, typed through the map or as a known type", () => {
		expect(applyHarvest(caps, ["n", "s", "x", "u"], ["int", "string", "nope"], "sortable").sortable).toEqual([
			{ field: "n", type: "number" },
			{ field: "s", type: "string" },
			{ field: "x" },
			{ field: "u" },
		])
		/* A repeated name takes the type at its first place. */
		expect(applyHarvest(caps, ["n", "n"], ["int", "string"], "sortable").sortable).toEqual([
			{ field: "n", type: "number" },
		])
		expect(applyHarvest({ ...caps, sortableFrom: { path: "$" } }, ["s"], ["int"], "sortable").sortable).toEqual([
			{ field: "s" },
		])
	})

	it("adds filterable rows by default, typed by position", () => {
		expect(applyHarvest(caps, ["n"], ["int"], "filterable").filterable).toEqual([
			{ field: "id" },
			{ field: "n", type: "number" },
		])
		expect(applyHarvest(caps, ["x"], ["nope"]).filterable).toEqual([{ field: "id" }, { field: "x" }])
		expect(applyHarvest(caps, ["id", "y"], ["string", "string"]).filterable).toEqual([
			{ field: "id", type: "string" },
			{ field: "y", type: "string" },
		])
		expect(applyHarvest(caps, ["z"]).filterable).toEqual([{ field: "id" }, { field: "z" }])
		expect(applyHarvest(emptyCapabilities(), ["q"], ["string"]).filterable).toEqual([{ field: "q", type: "string" }])
	})
})
