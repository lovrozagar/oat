import { describe, expect, it } from "vitest"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import { ASSERTED } from "../finding.ts"
import { accountsDoc } from "./__fixtures__/accounts.ts"
import { callerRead, destructiveOps, DISPOSABLE_CHECK_ID, disposableCheck, invalidatesCaller } from "./check.ts"

const model = modelOf(accountsDoc())
const op = (id: string) => {
	const found = model.byOperationId.get(id)
	if (found === undefined) throw new Error(`no ${id}`)
	return found
}

describe("disposableCheck", () => {
	it("plans nothing itself: destructive routes are graded after the entity loop", async () => {
		expect(disposableCheck.id).toBe(DISPOSABLE_CHECK_ID)
		expect(disposableCheck.mutates).toBe(true)
		expect(disposableCheck.plan({} as never)).toEqual({ ok: false })
		expect(disposableCheck.subjects({} as never, {} as never)).toEqual([])
		await expect(disposableCheck.run({} as never, {} as never)).resolves.toBe(ASSERTED)
	})
})

describe("destructiveOps / callerRead / invalidatesCaller", () => {
	it("finds the destructive operations and the caller's own read", () => {
		expect(destructiveOps(model).map((each) => each.operationId)).toEqual(["keys.delete", "auth.logout"])
		expect(callerRead(model)?.operationId).toBe("profile.read")
		const traced = {
			"/v1/sessions": { trace: { operationId: "sessions.trace", responses: {}, "x-destructive": true } },
		}
		expect(destructiveOps(modelOf(accountsDoc(traced))).map((each) => each.operationId)).not.toContain("sessions.trace")
		expect(callerRead(modelOf(accountsDoc({ "/v1/me": {} })))).toBeUndefined()
	})

	it("matches the caller read by `METHOD /path` or by its route", () => {
		const read = op("profile.read")
		expect(invalidatesCaller(op("auth.logout"), read)).toBe(true)
		expect(invalidatesCaller(op("keys.delete"), read)).toBe(false)
		expect(invalidatesCaller({ ...op("keys.delete"), invalidates: [read.route] }, { ...read, method: "x" })).toBe(true)
	})
})
