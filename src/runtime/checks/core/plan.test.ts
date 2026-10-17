import { describe, expect, it } from "vitest"
import { andThen, cannot, ready, when } from "./plan.ts"

describe("plans", () => {
	it("carries a value when ready and a reason when it cannot", () => {
		expect(ready(3)).toEqual({ ok: true, value: 3 })
		expect(cannot("a list operation")).toEqual({ needs: "a list operation", ok: false })
		expect(cannot()).toEqual({ ok: false })
	})

	it("chains stages, stopping at the first that cannot", () => {
		expect(andThen(ready(2), (n) => ready(n * 2))).toEqual({ ok: true, value: 4 })
		expect(andThen(cannot("x"), () => ready(1))).toEqual({ needs: "x", ok: false })
	})

	it("applies when a condition holds", () => {
		expect(when(true)).toEqual({ ok: true, value: undefined })
		expect(when(false, "y")).toEqual({ needs: "y", ok: false })
	})
})
