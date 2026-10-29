import { describe, expect, it } from "vitest"
import { cacheDeclaration } from "./consistency.ts"

describe("cacheDeclaration", () => {
	it("declares a 1 s staleness and the x-oat-fresh bypass under the cached-reads shape only", () => {
		expect(cacheDeclaration({ entities: [], shape: { cachedReads: true } })).toEqual({
			"x-consistency": { bypass: "x-oat-fresh: 1", staleness: "1s" },
		})
		expect(cacheDeclaration({ entities: [], shape: {} })).toEqual({})
	})
})
