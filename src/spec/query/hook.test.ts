import { describe, expect, it } from "vitest"
import { applyHook } from "./hook.ts"
import { emptyCapabilities } from "./merge.ts"

const seeded = {
	...emptyCapabilities(),
	aliases: { gt: "gte" as const },
	filterable: [{ field: "id" }],
	source: "tag" as const,
}

describe("capabilities hook", () => {
	it("keeps the merge for null, and replaces filterable for a list", () => {
		expect(applyHook(seeded, null)).toEqual({ ...seeded, hook: true })
		expect(applyHook(seeded, [{ field: "plain" }]).filterable).toEqual([{ field: "plain" }])
		expect(applyHook(seeded, [{ field: "dyn", ops: ["eq"], type: "string" }])).toEqual({
			...seeded,
			filterable: [{ field: "dyn", ops: ["eq"], type: "string" }],
			hook: true,
		})
	})

	it("replaces each axis and key an object sets, merging aliases", () => {
		const replaced = applyHook(seeded, {
			aliases: { ne: "neq" },
			emptyIn: "reject",
			filterable: [{ field: "dyn", ops: ["in"] }],
			searchable: null,
			selectable: ["dyn"],
			sortable: [{ field: "plain" }, { field: "dyn", nulls: ["first"], type: "string" }],
		})
		expect(replaced.filterable).toEqual([{ field: "dyn", ops: ["in"] }])
		expect(replaced.sortable).toEqual([{ field: "plain" }, { field: "dyn", nulls: ["first"], type: "string" }])
		expect(replaced.searchable).toEqual([])
		expect(replaced.selectable).toEqual(["dyn"])
		expect(replaced.aliases).toEqual({ gt: "gte", ne: "neq" })
		expect(replaced.emptyIn).toBe("reject")
		expect(applyHook(seeded, { searchable: ["q"] }).searchable).toEqual(["q"])
		expect(applyHook(seeded, {})).toEqual({ ...seeded, hook: true })
	})

	it("turns a heuristic map into config", () => {
		expect(applyHook({ ...seeded, source: "heuristic" }, {}).source).toBe("config")
		expect(applyHook({ ...seeded, source: "tag" }, {}).source).toBe("tag")
	})
})
