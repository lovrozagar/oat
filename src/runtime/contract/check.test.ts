import { describe, expect, it } from "vitest"
import { ASSERTED } from "../finding.ts"
import { CONTRACT_CHECK_ID, contractCallCheck } from "./check.ts"

describe("contractCallCheck", () => {
	it("plans nothing itself: the floor runs after every check", async () => {
		expect(contractCallCheck.id).toBe(CONTRACT_CHECK_ID)
		expect(contractCallCheck.plan({} as never)).toEqual({ ok: false })
		expect(contractCallCheck.subjects({} as never, {} as never)).toEqual([])
		await expect(contractCallCheck.run({} as never, {} as never)).resolves.toBe(ASSERTED)
	})
})
