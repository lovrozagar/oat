import { describe, expect, it } from "vitest"
import { toCanonicalFilter } from "./canonical.ts"
import { CLASSIC, PLAIN, POSTGREST, TEMPLATE } from "./presets.ts"

describe("toCanonicalFilter", () => {
	it("passes the canonical and the equality grammar through untouched", () => {
		expect(toCanonicalFilter("and(name.eq.x,status.neq.y)", POSTGREST)).toBe("and(name.eq.x,status.neq.y)")
		expect(toCanonicalFilter("status.eq.active", PLAIN)).toBe("status.eq.active")
	})

	it("reads repeated parameters only in the template grammar", () => {
		expect(toCanonicalFilter(["and_status_eq_active", "and_name_like_a"], TEMPLATE)).toBe(
			"and(status.eq.active,name.like.*a*)",
		)
		expect(toCanonicalFilter("or_status_eq_active", TEMPLATE)).toBe("status.eq.active")
		expect(toCanonicalFilter(["status.eq.active"], POSTGREST)).toBeNull()
	})

	it("rewrites colon terms, joining several with and()", () => {
		expect(toCanonicalFilter("name=eq:x", CLASSIC)).toBe("name.eq.x")
		expect(toCanonicalFilter(" name=eq:x , status=neq:a:b ", CLASSIC)).toBe("and(name.eq.x,status.neq.a:b)")
		expect(toCanonicalFilter("name=eq:", CLASSIC)).toBe("name.eq.")
	})

	it("refuses an empty or malformed colon expression", () => {
		for (const expression of ["", " , ", "name=x", "=eq:x", "name=EQ:x", "name=eq:x,junk"]) {
			expect(toCanonicalFilter(expression, CLASSIC)).toBeNull()
		}
	})
})
