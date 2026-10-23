import { describe, expect, it } from "vitest"
import type { Listed, WriteContext } from "../../core/context.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { NEEDS_LIST, planOn } from "../../core/run.ts"
import { listedRowIsTheGet } from "./list-item-matches-listed-row.ts"
import { notesBackend, notesDoc } from "./__fixtures__/notes.ts"

const listed = { id: "n1", status: "open", title: "alpha" }

/** A list-only notes context: a read route, no create, and `records` as the list returned them. */
function stage(respond: Responder, fields: Partial<Listed> = {}) {
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
		const unlike = "notes.get returned a body that does not contain the row notes.list already returned for n1"
		for (const [body, detail] of [
			[{ ...listed, status: "done" }, `${unlike}: status listed "open", got "done"`],
			[[listed], unlike],
			[null, unlike],
			["n1", unlike],
		] as const) {
			const staged = stage(answering(body))
			expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(staged.findings.findings[0]).toMatchObject({ detail, summary: "the get body is not the listed row" })
		}
	})

	it("is skipped as needing a list on an entity with none", async () => {
		const staged = stage(answering({}))
		const ctx: WriteContext = { ...staged.ctx, listOp: undefined }
		expect(planOn(listedRowIsTheGet, ctx)).toEqual({ needs: NEEDS_LIST, ok: false })
	})
})

describe("list.item-matches-listed-row nested values", () => {
	it("lets the get carry nested fields the listed row leaves out", async () => {
		const row = { access: { view: true }, id: "n1", mappers: [{ name: "a" }], tags: ["x"] }
		const body = {
			access: { configure: true, manage: false, view: true },
			id: "n1",
			mappers: [{ name: "a", protocol: "oidc" }],
			tags: ["x"],
		}
		const staged = stage(answering(body), { records: [row] })
		expect(await drive(staged)).toEqual({ kind: "asserted" })
	})

	it("reports a nested value that differs by its full path", async () => {
		const row = { access: { view: true }, id: "n1", mappers: [{ name: "a" }], tags: ["x", "y"], title: "alpha" }
		const body = {
			access: { manage: true, view: false },
			id: "n1",
			mappers: [{ name: "b" }],
			tags: ["x"],
			title: "alpha",
		}
		const staged = stage(answering(body), { records: [row] })
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe(
			"notes.get returned a body that does not contain the row notes.list already returned for n1: " +
				'access.view listed true, got false; mappers[0].name listed "a", got "b"; tags listed ["x","y"], got ["x"]',
		)
	})

	it("reports a listed field the get leaves out or answers with another shape", async () => {
		const row = { access: { view: true }, id: "n1", owner: null, tags: [] }
		const staged = stage(answering({ access: [true], id: "n1", tags: {} }), { records: [row] })
		expect(await drive(staged)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toContain(
			'access listed {"view":true}, got [true]; owner listed null, got nothing; tags listed [], got {}',
		)
	})

	it("names at most four differing fields", async () => {
		const row = { a: 1, b: 1, c: 1, d: 1, e: 1, id: "n1" }
		const staged = stage(answering({ a: 2, b: 2, c: 2, d: 2, e: 2, id: "n1" }), { records: [row] })
		await drive(staged)
		expect(staged.findings.findings[0]?.detail).toMatch(/d listed 1, got 2; and 1 more$/)
	})
})
