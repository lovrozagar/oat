import { describe, expect, it } from "vitest"
import { unionNamed, unionStrings } from "./union.ts"

describe("unions", () => {
	it("overlays a repeated name in its first place, copying every row", () => {
		const base = [{ field: "a", type: "string" }, { field: "b" }]
		const out = unionNamed<{ field: string; type?: string; ops?: string[] }>(base, [
			{ field: "c" },
			{ field: "a", ops: ["eq"] },
		])
		expect(out).toEqual([{ field: "a", ops: ["eq"], type: "string" }, { field: "b" }, { field: "c" }])
		expect(out[1]).not.toBe(base[1])
	})

	it("keeps the first of each string", () => {
		expect(unionStrings(["a", "b"], ["b", "c", "c"])).toEqual(["a", "b", "c"])
	})
})
