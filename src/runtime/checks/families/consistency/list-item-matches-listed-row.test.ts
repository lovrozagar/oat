import { describe, expect, it } from "vitest"
import type { CheckContext, WriteContext } from "../../core/context.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { listedRowIsTheGet } from "./list-item-matches-listed-row.ts"
import { notesBackend, notesDoc } from "./__fixtures__/notes.ts"

const listed = { id: "n1", status: "open", title: "alpha" }

/** A list-only notes context: a read route, no create, and `records` as the list returned them. */
function stage(respond: Responder, fields: Partial<CheckContext> = {}) {
	const model = modelOf(notesDoc())
	return contextFor(model, "notes.list", {
		respond,
		fields: { readOp: op(model, "notes.get"), records: [listed], ...fields },
	})
}

async function drive(staged: ReturnType<typeof stage>) {
	const planned = listedRowIsTheGet.plan(staged.ctx)
	if (!planned.ok) throw new Error(`the plan did not apply: ${planned.needs}`)
	return listedRowIsTheGet.run(staged.ctx, planned.value)
}

const answering =
	(body: unknown, status = 200): Responder =>
	() => ({ body, status })

describe("list.item-matches-listed-row plan", () => {
	it("applies only to a list with a read and no create", () => {
		const model = modelOf(notesDoc())
		expect(listedRowIsTheGet.plan(stage(notesBackend([]), { readOp: undefined }).ctx)).toEqual({ ok: false })
		expect(listedRowIsTheGet.plan(stage(notesBackend([]), { createOp: op(model, "notes.create") }).ctx)).toEqual({
			ok: false,
		})
	})

	it("needs a listed row with a string or numeric id", () => {
		const noId = { needs: "the list returned no id", ok: false }
		expect(listedRowIsTheGet.plan(stage(notesBackend([]), { records: [] }).ctx)).toEqual(noId)
		expect(listedRowIsTheGet.plan(stage(notesBackend([]), { records: [{ id: { v: 1 } }] }).ctx)).toEqual(noId)
		expect(listedRowIsTheGet.plan(stage(notesBackend([]), { records: [{ id: 7 }] }).ctx)).toEqual({
			ok: true,
			value: { id: "7", listed: { id: 7 } },
		})
	})

	it("judges only the read operation", () => {
		const model = modelOf(notesDoc())
		const note = model.entities.get("note")
		const org = model.entities.get("org")
		if (note === undefined || org === undefined) throw new Error("the document lost an entity")
		expect(listedRowIsTheGet.subjects(note, model)).toEqual(["notes.get"])
		expect(listedRowIsTheGet.subjects(org, model)).toEqual([])
	})
})

describe("list.item-matches-listed-row run", () => {
	it("asserts when the get serves the listed row, extra fields allowed", async () => {
		const staged = stage(answering({ ...listed, body: "more" }))
		expect(await drive(staged)).toEqual({ kind: "asserted" })
		expect(staged.sent).toMatchObject([{ method: "GET", options: { operationId: "notes.get" }, path: "/notes/n1" }])
	})

	it("stands down when the context lost its read operation", async () => {
		const staged = stage(notesBackend([listed]))
		const planned = listedRowIsTheGet.plan(staged.ctx)
		if (!planned.ok) throw new Error("the plan did not apply")
		const ctx = { ...staged.ctx, readOp: undefined }
		expect(await listedRowIsTheGet.run(ctx, planned.value)).toEqual({
			kind: "stood-down",
			reason: "the entity has no read",
		})
		expect(staged.sent).toEqual([])
	})

	it("reports a listed row its get does not return", async () => {
		const staged = stage(answering(null, 404))
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: "notes.get returned 404 for note n1",
			summary: "the listed row is not returned by its get",
		})
	})

	it("reports a get body that differs from the listed row", async () => {
		for (const body of [{ ...listed, status: "done" }, [listed], null, "n1"]) {
			const staged = stage(answering(body))
			expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(staged.findings.findings[0]).toMatchObject({
				detail: "notes.get returned a body that does not contain the row notes.list already returned for n1",
				summary: "the get body is not the listed row",
			})
		}
	})

	it("names the list generically when the context carries none", async () => {
		const staged = stage(answering({}))
		const ctx = { ...staged.ctx, listOp: undefined } as unknown as WriteContext
		await listedRowIsTheGet.run(ctx, { id: "n1", listed })
		expect(staged.findings.findings[0]?.detail).toContain("the row the list already returned")
	})
})
