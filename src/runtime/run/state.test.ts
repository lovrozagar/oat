import { describe, expect, it } from "vitest"
import { emptyState } from "./state.ts"

describe("emptyState", () => {
	it("starts a run with nothing gathered", () => {
		const state = emptyState()
		expect(state).toMatchObject({ entitiesTested: [], interrupted: false, teardown: null, verifyHookFailed: false })
		expect(state.checksRun.size).toBe(0)
		expect(emptyState().checksRun).not.toBe(state.checksRun)
	})
})
