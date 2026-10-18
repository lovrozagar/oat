import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../../../client/types.ts"
import type { Answer } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext, notesModel } from "./__fixtures__/notes.ts"
import { createPersistsFields } from "./create-persists-submitted-fields.ts"

/*
 * A create that answers 2xx must carry back what it was sent. The check judges the create the
 * transcript already holds: its body, read as a form when it was one, against the echoed record.
 * Defect: create-drops-field — the answer leaves out a submitted field.
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

/** A context whose transcript holds one create: `options` sent, `answer` returned. */
async function afterCreate(options: RequestOptions, answer: Answer) {
	const stage = notesContext(MODEL, () => answer, { records: COHORT })
	await stage.ctx.client.request("POST", "/notes", { ...options, operationId: "note.create" })
	return stage
}

async function judge(options: RequestOptions, answer: Answer) {
	const stage = await afterCreate(options, answer)
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

	it("fails a create that answers without a record", async () => {
		const { outcome } = await judge({ body: { name: "a" } }, { status: 201 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
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

	it("does not plan without a create, a cohort, or an echoed record", () => {
		const { ctx } = notesContext(MODEL, () => undefined, { records: COHORT })
		expect(createPersistsFields.plan({ ...ctx, createOp: undefined }).ok).toBe(false)
		expect(createPersistsFields.plan({ ...ctx, records: [] }).ok).toBe(false)
		expect(createPersistsFields.plan({ ...ctx, createAcknowledged: true }).ok).toBe(false)
	})
})
