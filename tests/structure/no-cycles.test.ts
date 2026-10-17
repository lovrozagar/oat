import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cycles, importGraph } from "../support/import-graph.ts"

/* An import cycle makes load order matter and splits nothing: every module in it is one module. */

const ROOT = join(import.meta.dirname, "..", "..")

describe("no import cycles", () => {
	it("src imports form a DAG, counting type-only imports and re-exports", () => {
		expect(cycles(importGraph(ROOT, "src"))).toEqual([])
	})

	it("the finder reports a cycle it is given, and a self-import", () => {
		const graph = new Map([
			["a.ts", new Set(["b.ts"])],
			["b.ts", new Set(["c.ts"])],
			["c.ts", new Set(["a.ts"])],
			["d.ts", new Set(["d.ts"])],
			["e.ts", new Set(["a.ts"])],
		])
		expect(cycles(graph)).toEqual([["a.ts", "b.ts", "c.ts"], ["d.ts"]])
	})
})
