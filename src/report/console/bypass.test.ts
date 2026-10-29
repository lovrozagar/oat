import { describe, expect, it } from "vitest"
import { bypassRows } from "./bypass.ts"

describe("bypassRows", () => {
	it("names the reads of a declared bypass, and only counts the default's", () => {
		expect(
			bypassRows([
				{ bypass: "x-fresh: 1", operations: ["notes.get"], source: "declared" },
				{ bypass: "cache-control: no-cache", operations: ["a", "b"], source: "default" },
				{ bypass: null, operations: ["a"], source: "off" },
			]),
		).toEqual([
			"    declared x-fresh: 1                  1 read: notes.get",
			"    default cache-control: no-cache      2 reads",
			"    off (config cache.bypass)            1 read",
		])
	})
})
