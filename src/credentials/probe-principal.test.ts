import { describe, expect, it } from "vitest"
import { isProbePrincipal, probeOwner, probePrincipal, withoutProbes } from "./probe-principal.ts"

describe("probe principals", () => {
	it("are named for their owner, and name it back", () => {
		const probe = probePrincipal("alpha", 2)
		expect(probe).toBe("alpha#probe-2")
		expect([probeOwner(probe), isProbePrincipal(probe)]).toEqual(["alpha", true])
	})

	it("are named by their owner in any text a report carries", () => {
		expect(withoutProbes('login for "ann#probe-12" failed; ann#probe-3 too')).toBe('login for "ann" failed; ann too')
	})

	it("leave any other principal its own, a # in its id included", () => {
		for (const id of ["alpha", "a#b", "alpha#probe-x"])
			expect([probeOwner(id), isProbePrincipal(id)]).toEqual([id, false])
	})
})
