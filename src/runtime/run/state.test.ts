import { describe, expect, it } from "vitest"
import { emptyState, takenOf } from "./state.ts"

describe("emptyState", () => {
	it("starts a run with nothing gathered", () => {
		const state = emptyState()
		expect(state).toMatchObject({ entitiesTested: [], interrupted: false, teardown: null, verifyHookFailed: false })
		expect(state.checksRun.size).toBe(0)
		expect(emptyState().checksRun).not.toBe(state.checksRun)
	})
})

describe("takenOf", () => {
	it("keeps one set of identities per entity for the whole run", () => {
		const state = emptyState()
		takenOf(state, "table").add("7")
		expect([...takenOf(state, "table")]).toEqual(["7"])
		expect(takenOf(state, "row").size).toBe(0)
		expect(state.takenByEntity.get("table")).toBe(takenOf(state, "table"))
	})
})
