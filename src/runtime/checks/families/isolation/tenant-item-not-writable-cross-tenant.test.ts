import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesBackend } from "./__fixtures__/backend.ts"
import { type Backend, caller, notesContext } from "./__fixtures__/context.ts"
import { type NotesOptions, notesDocument } from "./__fixtures__/notes.ts"
import { crossTenantItemWrite } from "./tenant-item-not-writable-cross-tenant.ts"

const MEMBERS = { other: "o2", owner: "o1" }
/** A create that answers with `record`, and a read that answers it back; nothing else. */
const creating = (record: Record<string, unknown>) => (method: string, path: string) =>
	method === "POST" || (method === "GET" && path.endsWith(`/${String(record["id"])}`))
		? { body: record, status: method === "POST" ? 201 : 200 }
		: { status: 404 }
/* A note whose only string is empty, and one whose string field the request schema does not know. */
const createsBlank = creating({ id: "s1", title: "" })
const createsUnschemed = creating({ id: "s1", slug: "made" })
const modelWith = (options: NotesOptions = {}) => modelOf(notesDocument(options))

describe("tenant.item-not-writable-cross-tenant", () => {
	it("passes when another tenant can neither change nor delete a record", async () => {
		const backend = notesBackend({ members: MEMBERS })
		const { ctx, findings, sent } = notesContext(modelWith(), backend)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => `${s.method} ${s.path} ${caller(s)}`)).toEqual([
			"POST /orgs/o1/notes owner",
			"PATCH /orgs/o2/notes/s1 other",
			"GET /orgs/o1/notes/s1 owner",
			"DELETE /orgs/o2/notes/s1 other",
			"GET /orgs/o1/notes/s1 owner",
		])
		/* Every request names its operation, so each is sent the credential its own security asks for. */
		expect(sent.map((s) => s.options.operationId)).toEqual([
			"createNote",
			"updateNote",
			"readNote",
			"deleteNote",
			"readNote",
		])
		expect(findings.findings).toEqual([])
		expect(backend.notes.get("o1")?.has("s1")).toBe(true)
	})

	it("reports SECURITY when a declared tenant's record takes another tenant's change", async () => {
		const backend = notesBackend({ members: MEMBERS, writesById: true })
		const { ctx, findings } = notesContext(modelWith({ tenant: "org_id" }), backend)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.summary).toBe("a record can be changed by a principal in another tenant")
		expect(findings.findings[0]?.detail).toContain('set "body"')
		expect(findings.findings[0]?.detail).toContain('x-tenant: "org_id"')
	})

	it("reports a cross-tenant delete when only delete is scoped by id", async () => {
		const backend = notesBackend({ members: MEMBERS, writesById: true })
		const { ctx, findings, sent } = notesContext(modelWith({ without: ["updateNote"] }), backend)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "finding", verdict: "AMBIGUITY" })
		expect(findings.findings[0]?.summary).toBe("a record can be deleted by a principal in another tenant")
		expect(findings.findings[0]?.detail).toContain('inferred tenant scoping from the "org_id" path parameter')
		expect(sent.map((s) => s.method)).toEqual(["POST", "DELETE", "GET"])
	})
})

describe("tenant.item-not-writable-cross-tenant: writes that did not take", () => {
	it("does not count a delete the owner still reads past, or a refused one", async () => {
		const respondLeaky = notesBackend({ members: MEMBERS })
		const answers: Backend = (method, path, options) =>
			method === "DELETE" ? { status: 204 } : respondLeaky(method, path, options)
		const { ctx, findings } = notesContext(modelWith({ without: ["updateNote"] }), answers)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("does not count a change the owner cannot read back", async () => {
		const backend = notesBackend({ members: MEMBERS, writesById: true })
		const answers: Backend = (method, path, options) =>
			method === "GET" ? { status: 500 } : backend(method, path, options)
		const { ctx, findings } = notesContext(modelWith({ without: ["deleteNote"] }), answers)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("tries no update when the record has no field it could change", async () => {
		const { ctx, sent } = notesContext(modelWith({ without: ["deleteNote"] }), createsBlank)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.method)).toEqual(["POST", "GET"])
	})

	it("tries no update when no changed value can be made for the field", async () => {
		const { ctx, sent } = notesContext(modelWith({ without: ["deleteNote"] }), createsUnschemed)
		expect(await runCheck(crossTenantItemWrite, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.method)).toEqual(["POST", "GET"])
	})
})

describe("tenant.item-not-writable-cross-tenant planning", () => {
	it("hands back what the scratch create concluded when no record could be made", async () => {
		const backend = notesBackend({ createStatus: 500, members: MEMBERS })
		const { ctx, sent } = notesContext(modelWith(), backend)
		expect((await runCheck(crossTenantItemWrite, ctx)).kind).toBe("unresolved")
		expect(sent).toHaveLength(1)
	})

	it("writes under the owner's scope when the peer has none", async () => {
		const backend = notesBackend({ members: MEMBERS })
		const { ctx, sent } = notesContext(modelWith(), backend, { peerScope: undefined })
		await runCheck(crossTenantItemWrite, ctx)
		expect(sent[1]?.path).toBe("/orgs/o1/notes/s1")
	})

	it("stands down without a second tenant, a read, a create, or a tenant-scoped write", () => {
		const shared = modelWith({ tenant: false })
		const backend = notesBackend({ members: MEMBERS })
		for (const { ctx } of [
			notesContext(modelWith(), backend, { peer: undefined }),
			notesContext(modelWith(), backend, { readOp: undefined }),
			notesContext(modelWith(), backend, { createOp: undefined }),
			notesContext(modelWith({ without: ["updateNote", "deleteNote"] }), backend),
			notesContext(shared, backend),
		]) {
			expect(crossTenantItemWrite.plan(ctx)).toEqual({ ok: false })
		}
	})

	it("grades the entity's update and delete", () => {
		const model = modelWith()
		const entity = model.entities.get("note")
		expect(entity === undefined ? [] : crossTenantItemWrite.subjects(entity, model)).toEqual([
			"updateNote",
			"deleteNote",
		])
	})
})
