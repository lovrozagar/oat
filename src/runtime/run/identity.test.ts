import { describe, expect, it } from "vitest"
import { boundOf } from "./identity.ts"

describe("boundOf", () => {
	it("splits a principal's identity into its tenant, its scope and the data recipes interpolate", () => {
		const held = {
			email: "a@x.test",
			"scope.project_id": "p9",
			scope: { org_id: "o1", project_id: "p1" },
			tenant: "t1",
		}
		expect(boundOf(held)).toEqual({
			identity: { email: "a@x.test" },
			scope: { org_id: "o1", project_id: "p9" },
			tenant: "t1",
		})
	})

	it("has no tenant unless one is a string, and keeps only string parameters", () => {
		expect(boundOf({ "scope.n": 3, scope: ["x"], tenant: 4 })).toEqual({ identity: {}, scope: {} })
		expect(boundOf({ scope: { a: "1", b: 2 } })).toEqual({ identity: {}, scope: { a: "1" } })
	})
})
