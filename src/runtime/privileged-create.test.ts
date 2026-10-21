import { describe, expect, it } from "vitest"
import { privilegedBar } from "./privileged-create.ts"

/* Only the highest rank of a tenant sends a create whose body requires an x-privileged property. */

const create = { operationId: "table.create", privilegedRequired: ["verified"] }
const admin = { id: "alpha", rank: 2, tenant: "t1" }
const member = { id: "alpha_member", rank: 1, tenant: "t1" }
const outsider = { id: "beta", rank: 3, tenant: "t2" }

describe("privilegedBar", () => {
	it("bars a principal its own tenant outranks, naming the fields and who may set them", () => {
		expect(privilegedBar(create, member, [admin, member, outsider])).toBe(
			"table.create requires verified, marked x-privileged, which only alpha (rank 2) may set; " +
				"alpha_member (rank 1) does not send it",
		)
	})

	it("lets the highest rank of the tenant send it, whatever another tenant holds", () => {
		expect(privilegedBar(create, admin, [admin, member, outsider])).toBeUndefined()
		expect(privilegedBar(create, { ...admin, rank: 1 }, [{ ...admin, rank: 1 }, member])).toBeUndefined()
	})

	it("lets anyone send a create that requires no x-privileged property", () => {
		expect(privilegedBar({ ...create, privilegedRequired: [] }, member, [admin, member])).toBeUndefined()
	})
})
