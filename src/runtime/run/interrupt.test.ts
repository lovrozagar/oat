import { describe, expect, it } from "vitest"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { noteLateStop, stopped } from "./interrupt.ts"

describe("stopped", () => {
	it("is true once the run is aborted from outside", async () => {
		const controller = new AbortController()
		const ctx = await contextOf(optionsFor(notesApi(), { signal: controller.signal }))
		expect(stopped(ctx)).toBe(false)
		controller.abort()
		expect(stopped(ctx)).toBe(true)
	})
})

describe("noteLateStop", () => {
	it("reports a stop that came after every entity started, once", async () => {
		const controller = new AbortController()
		const ctx = await contextOf(optionsFor(notesApi(), { signal: controller.signal }))
		noteLateStop(ctx)
		expect(ctx.findings.findings).toEqual([])
		controller.abort()
		ctx.progress.phase = "contract"
		noteLateStop(ctx)
		noteLateStop(ctx)
		expect(ctx.state.interrupted).toBe(true)
		expect(ctx.findings.findings.map((finding) => finding.summary)).toEqual(["stopped during the contract phase"])
	})
})
