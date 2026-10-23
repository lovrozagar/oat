import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../../../client/types.ts"
import type { Answer } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext, notesModel } from "./__fixtures__/notes.ts"
import { createPersistsFields } from "./create-persists-submitted-fields.ts"

/*
 * A create that answers 2xx must persist what it was sent. The check judges the create the
 * transcript already holds: its body, read as a form when it was one, against the record read back
 * by the created id through the item read, and the echoed record when the create answered one.
 * Defect: create-drops-field — the stored record leaves out a submitted field.
 */

const MODEL = notesModel()
const COHORT = [{ id: "n0", name: "zero" }]

const PROPERTIES = {
	flags: { items: { type: "boolean" }, type: "array" },
	name: { type: "string" },
	open: { type: "boolean" },
	ratio: { type: "number" },
	secret: { type: "string", writeOnly: true },
	size: { type: "integer" },
}

/** A context whose transcript holds one create: `options` sent, `answer` returned; no item read. */
async function afterCreate(options: Omit<RequestOptions, "as">, answer: Answer, read?: Answer) {
	const respond = (method: string) => (method === "GET" ? read : answer)
	const readOp = read === undefined ? { readOp: undefined } : {}
	const stage = notesContext(MODEL, respond, { records: COHORT, ...readOp })
	await stage.ctx.client.request("POST", "/notes", {
		...options,
		as: { principal: "alpha" },
		operationId: "note.create",
	})
	return stage
}

async function judge(options: Omit<RequestOptions, "as">, answer: Answer, read?: Answer) {
	const stage = await afterCreate(options, answer, read)
	const outcome = await createPersistsFields.run(stage.ctx, {
		createOp: MODEL.byOperationId.get("note.create") as never,
		properties: PROPERTIES,
	})
	return { ...stage, outcome }
}

const urlencoded = { "content-type": "application/x-www-form-urlencoded" }

describe("create.persists-submitted-fields on JSON bodies", () => {
	it("passes a create that echoes every field it was sent", async () => {
		const body = { name: "a", size: 3 }
		const { outcome, findings } = await judge({ body }, { body: { ...body, id: "n1" }, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("fails a create whose answer drops a field or changes one", async () => {
		const body = { name: "a", size: 3, title: "t" }
		const { outcome, findings } = await judge({ body }, { body: { id: "n1", name: "a", size: 4 }, status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("create silently discards submitted fields")
		expect(findings.findings[0]?.detail).toContain("2 submitted field(s)")
		expect(findings.findings[0]?.detail).toContain("size sent 3, got 4")
		expect(findings.findings[0]?.detail).toContain("title sent")
	})

	it("stands down on a create that answers only an acknowledgement and has no item read", async () => {
		for (const answer of [{ status: 201 }, { body: { id: 5, message: "Order sent successfully." }, status: 200 }]) {
			const { outcome, findings } = await judge({ body: { name: "a" } }, answer)
			expect(outcome).toEqual({
				kind: "stood-down",
				reason:
					"note.create answered an acknowledgement, not the record, and the entity has no item read to read it back by",
			})
			expect(findings.findings).toEqual([])
		}
	})

	it("does not count write-only, null or unset fields as dropped", async () => {
		const body = { gone: undefined, name: "a", note: null, secret: "s" }
		const { outcome } = await judge({ body }, { body: { id: "n1", name: "a" }, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
	})

	it("stands down when the body held no fields", async () => {
		for (const body of [{}, "text", ["a"]]) {
			const { outcome } = await judge({ body }, { body: { id: "n1" }, status: 201 })
			expect(outcome).toEqual({ kind: "stood-down", reason: "the create body was empty" })
		}
	})

	it("is unresolved when no create or no create body was observed", async () => {
		const none = notesContext(MODEL, () => undefined, { records: COHORT })
		expect((await runCheck(createPersistsFields, none.ctx)).kind).toBe("unresolved")
		const bodiless = await afterCreate({}, { body: { id: "n1" }, status: 201 })
		const outcome = await runCheck(createPersistsFields, bodiless.ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: "no create request body was observed" })
	})
})

describe("create.persists-submitted-fields on acknowledgement-only creates", () => {
	const ack = { body: { id: 5, message: "Order sent successfully." }, status: 200 }

	it("passes an acknowledgement-only create whose record holds every field it was sent", async () => {
		const body = { name: "a", size: 3 }
		const { outcome, findings, sent } = await judge({ body }, ack, { body: { ...body, id: 5 }, status: 200 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.at(-1)).toMatchObject({ method: "GET", path: "/notes/5" })
	})

	it("fails an acknowledgement-only create whose record read back lacks a field", async () => {
		const body = { name: "a", size: 3 }
		const { outcome, findings } = await judge({ body }, ack, { body: { id: 5, name: "a" }, status: 200 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("create silently discards submitted fields")
		expect(findings.findings[0]?.detail).toContain(
			"the record note.get reads back under 5 does not hold 1 submitted field(s): size sent 3, got undefined",
		)
		expect(findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("reads back under the identity the client sent when the answer names none", async () => {
		const body = { id: "n7", name: "a" }
		const { outcome, sent } = await judge({ body }, { status: 204 }, { body, status: 200 })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(sent.at(-1)).toMatchObject({ method: "GET", path: "/notes/n7" })
	})

	it("stands down on an acknowledgement whose record cannot be read back", async () => {
		const { outcome } = await judge({ body: { name: "a" } }, ack, { status: 404 })
		expect(outcome).toEqual({
			kind: "stood-down",
			reason: "note.create answered an acknowledgement, not the record, and note.get answered 404 for it under 5",
		})
	})

	it("stands down on an acknowledgement that names no id to read back by", async () => {
		const { outcome, sent } = await judge(
			{ body: { name: "a" } },
			{ body: { message: "ok" }, status: 200 },
			{ status: 200 },
		)
		expect(outcome).toEqual({
			kind: "stood-down",
			reason: "note.create answered an acknowledgement, not the record, and named no id to read it back by",
		})
		expect(sent.filter((request) => request.method === "GET")).toEqual([])
	})
})

describe("create.persists-submitted-fields with an echo and a read back", () => {
	it("passes a create whose echo leaves out a field the read back holds", async () => {
		const body = { name: "a", size: 3 }
		const { outcome } = await judge(
			{ body },
			{ body: { id: "n1", name: "a" }, status: 201 },
			{ body: { ...body, id: "n1" }, status: 200 },
		)
		expect(outcome).toEqual({ kind: "asserted" })
	})

	it("does not call a field the item read leaves out dropped when the create echoed it", async () => {
		const body = { name: "a", size: 3 }
		const { outcome } = await judge(
			{ body },
			{ body: { ...body, id: "n1" }, status: 201 },
			{ body: { id: "n1", name: "a" }, status: 200 },
		)
		expect(outcome).toEqual({ kind: "asserted" })
	})

	it("fails a field neither the echo nor the read back holds as sent", async () => {
		const body = { name: "a", size: 3 }
		const { outcome, findings } = await judge(
			{ body },
			{ body: { id: "n1", name: "a" }, status: 201 },
			{ body: { id: "n1", name: "a", size: 4 }, status: 200 },
		)
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain(
			"the create response does not carry back 1 submitted field(s): size sent 3, got undefined",
		)
		expect(findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("judges the echo alone when the read back fails", async () => {
		const body = { name: "a", size: 3 }
		const echo = { body: { id: "n1", name: "a" }, status: 201 }
		const { outcome, findings } = await judge({ body }, echo, { status: 404 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("the create response does not carry back 1 submitted field(s)")
	})
})

describe("create.persists-submitted-fields on form bodies", () => {
	it("compares a urlencoded body's fields typed as the record stores them", async () => {
		const body = { flags: ["true", "false"], name: "a", open: "true", ratio: "1.5", size: "3", skipped: [7] }
		const record = { flags: [true, false], id: "n1", name: "a", open: true, ratio: 1.5, size: 3 }
		const { outcome } = await judge({ body, headers: urlencoded }, { body: record, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
	})

	it("keeps form text that is not a number or a boolean as it was sent", async () => {
		const body = { open: "yes", ratio: "lots", size: " ", tag: "x" }
		const record = { id: "n1", open: "yes", ratio: "lots", size: " ", tag: "x" }
		const { outcome } = await judge({ body, headers: urlencoded }, { body: record, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
	})

	it("fails a form create whose typed value did not persist", async () => {
		const { outcome, findings } = await judge(
			{ body: new URLSearchParams([["size", "3"]]), headers: urlencoded },
			{ body: { id: "n1", size: "3" }, status: 201 },
		)
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain('size sent 3, got "3"')
	})

	it("reads FormData and multipart parts, text fields only", async () => {
		const form = new FormData()
		form.append("name", "a")
		form.append("file", new Blob(["x"]))
		const parts = {
			parts: [
				{ field: "name", value: "a" },
				{ field: "file", filename: "f" },
			],
		}
		for (const body of [form, parts]) {
			const { outcome } = await judge({ body }, { body: { id: "n1", name: "a" }, status: 201 })
			expect(outcome).toEqual({ kind: "asserted" })
		}
	})

	it("takes the last value of a repeated scalar field", async () => {
		const body = new URLSearchParams([
			["size", "1"],
			["size", "2"],
		])
		const { outcome } = await judge({ body }, { body: { id: "n1", size: 2 }, status: 201 })
		expect(outcome).toEqual({ kind: "asserted" })
	})
})

describe("create.persists-submitted-fields plan", () => {
	it("plans with the create's request properties", () => {
		const { ctx } = notesContext(MODEL, () => undefined, { records: COHORT })
		const planned = createPersistsFields.plan(ctx)
		expect(planned.ok && Object.keys(planned.value.properties)).toEqual(["code", "name", "size", "title"])
	})

	it("plans with no properties when the create documents no body", () => {
		const model = notesModel({ createWithoutBody: true })
		const { ctx } = notesContext(model, () => undefined, { records: COHORT })
		const planned = createPersistsFields.plan(ctx)
		expect(planned.ok && planned.value.properties).toEqual({})
	})

	it("does not plan without a create or a cohort", () => {
		const { ctx } = notesContext(MODEL, () => undefined, { records: COHORT })
		expect(createPersistsFields.plan({ ...ctx, createOp: undefined }).ok).toBe(false)
		expect(createPersistsFields.plan({ ...ctx, records: [] }).ok).toBe(false)
	})

	it("plans for an acknowledgement-only create, which is read back", () => {
		const { ctx } = notesContext(MODEL, () => undefined, { records: COHORT })
		expect(createPersistsFields.plan({ ...ctx, createAcknowledged: true }).ok).toBe(true)
	})
})
