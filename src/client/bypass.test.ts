import { describe, expect, it } from "vitest"
import { bypassLayer } from "./bypass.ts"
import type { ResolvedOperation } from "./types.ts"

const read = (more: Partial<ResolvedOperation> = {}): ResolvedOperation => ({
	operationId: "row.get",
	template: "/rows/{id}",
	...more,
})
const DECLARED = read({ bypass: { name: "x-fresh", value: "1" } })

describe("bypassLayer", () => {
	it("sends the bypass a read declares", () => {
		expect(bypassLayer({ enabled: true, method: "GET", resolved: DECLARED }, [])).toEqual({ "x-fresh": "1" })
		expect(bypassLayer({ enabled: true, method: "HEAD", resolved: DECLARED }, [])).toEqual({ "x-fresh": "1" })
	})

	it("sends Cache-Control: no-cache on a read that declares none", () => {
		expect(bypassLayer({ enabled: true, method: "GET", resolved: read() }, [])).toEqual({
			"cache-control": "no-cache",
		})
	})

	it("sends nothing on a write, on an undocumented request, or on a read that asks to use the cache", () => {
		expect(bypassLayer({ enabled: true, method: "POST", resolved: DECLARED }, [])).toEqual({})
		expect(bypassLayer({ enabled: true, method: "GET", resolved: null }, [])).toEqual({})
		expect(bypassLayer({ cache: "use", enabled: true, method: "GET", resolved: DECLARED }, [])).toEqual({})
	})

	it("sends nothing when the config turns the bypass off", () => {
		expect(bypassLayer({ enabled: false, method: "GET", resolved: DECLARED }, [])).toEqual({})
		expect(bypassLayer({ enabled: false, method: "GET", resolved: read() }, [])).toEqual({})
	})

	it("never overrides the header a global, hook or caller layer already sends, whatever its case", () => {
		expect(bypassLayer({ enabled: true, method: "GET", resolved: read() }, [{ "Cache-Control": "max-age=0" }])).toEqual(
			{},
		)
		expect(bypassLayer({ enabled: true, method: "GET", resolved: DECLARED }, [{}, { "X-Fresh": "0" }])).toEqual({})
	})
})
