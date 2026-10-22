import { describe, expect, it } from "vitest"
import { loaded, notesApi, notesDoc, optionsFor } from "./__fixtures__/api.ts"
import { createExclusion } from "./exclusion.ts"

/* A profile leaves out what it names; the default runs everything. */

const writesExcluded = { profile: "readonly", profiles: { readonly: { exclude: ["notes.create"] } } }

async function exclusionFor(extra = {}) {
	const run = await loaded(optionsFor(notesApi(), extra))
	const note = run.model.entities.get("note")
	if (note === undefined) throw new Error("the notes document has no note entity")
	return { exclusion: createExclusion(run), note, run }
}

describe("createExclusion", () => {
	it("excludes nothing under the full profile", async () => {
		const { exclusion, note, run } = await exclusionFor()
		const create = run.model.byOperationId.get("notes.create")
		expect(exclusion.excludeOp(note, create)).toBe(false)
		expect(exclusion.excludeOp(note, undefined)).toBe(false)
		expect(exclusion.excludes("notes.create")).toBe(false)
		expect(exclusion.excludes("no.such")).toBe(false)
		expect(create !== undefined && exclusion.readable(create)).toBe(true)
	})

	it("excludes an operation oat never sends, under every profile, without a profile finding", async () => {
		const traced = notesDoc({ "/notes/{note_id}/echo": { trace: { operationId: "notes.echo", responses: {} } } })
		const run = await loaded(optionsFor(notesApi(traced)))
		const exclusion = createExclusion(run)
		const echo = run.model.byOperationId.get("notes.echo")
		expect(exclusion.excludes("notes.echo")).toBe(true)
		expect(echo !== undefined && exclusion.readable(echo)).toBe(false)
		expect(run.findings.findings).toEqual([])
	})

	it("reports an excluded operation once, and excludes it every time", async () => {
		const { exclusion, note, run } = await exclusionFor(writesExcluded)
		const create = run.model.byOperationId.get("notes.create")
		expect(exclusion.excludeOp(note, create)).toBe(true)
		expect(exclusion.excludeOp(note, create)).toBe(true)
		expect(exclusion.excludes("notes.create")).toBe(true)
		expect(create !== undefined && exclusion.readable(create)).toBe(false)
		expect(run.state.profileExclusions).toEqual([
			expect.objectContaining({ entity: "note", operationId: "notes.create" }),
		])
		expect(run.findings.findings).toEqual([
			expect.objectContaining({ check: "profile.skip", operations: ["notes.create"], verdict: "COVERAGE_GAP" }),
		])
	})
})
