import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { caller, notesContext, OTHER } from "./__fixtures__/context.ts"
import { notesDocument } from "./__fixtures__/notes.ts"
import { crossTenantItemRead } from "./tenant-item-not-readable-cross-tenant.ts"

const inferred = modelOf(notesDocument())
const tagged = modelOf(notesDocument({ tenant: "org_id" }))

/** A backend that answers the other tenant's read of note n1 with `status`. */
const answering = (status: number) => (_method: string, path: string, options: { headers?: unknown }) =>
	path === "/orgs/o2/notes/n1" && caller(options) === OTHER.authorization
		? { body: { id: "n1", title: "first" }, status }
		: undefined

describe("tenant.item-not-readable-cross-tenant", () => {
	it("passes when the other tenant is refused, reading under its own root", async () => {
		for (const status of [403, 404]) {
			const { ctx, findings, sent } = notesContext(inferred, answering(status))
			expect(await runCheck(crossTenantItemRead, ctx)).toEqual({ kind: "asserted" })
			expect(sent.map((s) => `${s.method} ${s.path} ${caller(s.options)}`)).toEqual(["GET /orgs/o2/notes/n1 other"])
			expect(findings.findings).toEqual([])
		}
	})

	it("reads under the owner's scope when the other principal has none of its own", async () => {
		const { ctx, sent } = notesContext(inferred, answering(404), { altScope: undefined })
		await runCheck(crossTenantItemRead, ctx)
		expect(sent[0]?.path).toBe("/orgs/o1/notes/n1")
	})

	it("is unresolved when the read fails for another reason", async () => {
		const { ctx, findings } = notesContext(inferred, answering(500))
		expect(await runCheck(crossTenantItemRead, ctx)).toEqual({
			kind: "unresolved",
			reason: "the cross-tenant read failed for another reason",
		})
		expect(findings.inconclusive).toHaveLength(1)
	})

	it("reports SECURITY when a declared tenant's record is served to another tenant", async () => {
		const { ctx, findings } = notesContext(tagged, answering(200))
		expect(await runCheck(crossTenantItemRead, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.summary).toBe("a record is readable by a principal in another tenant")
		expect(findings.findings[0]?.detail).toContain('x-tenant: "org_id"')
		expect(findings.findings[0]?.evidence[0]?.status).toBe(200)
	})

	it("reports AMBIGUITY and still passes when the tenant was only inferred", async () => {
		const { ctx, findings } = notesContext(inferred, answering(200))
		expect(await runCheck(crossTenantItemRead, ctx)).toEqual({ kind: "asserted" })
		expect(findings.byVerdict("AMBIGUITY")).toHaveLength(1)
		expect(findings.findings[0]?.detail).toContain('inferred tenant scoping from the "org_id"')
	})
})

describe("tenant.item-not-readable-cross-tenant planning", () => {
	it("stands down without a second tenant, a read, a record or a boundary", async () => {
		const shared = modelOf(notesDocument({ tenant: false }))
		const cases = [
			notesContext(inferred, answering(200), { altAuth: undefined }),
			notesContext(inferred, answering(200), { readOp: undefined }),
			notesContext(inferred, answering(200), { records: [] }),
			notesContext(shared, answering(200)),
		]
		for (const { ctx, sent } of cases) {
			expect((await runCheck(crossTenantItemRead, ctx)).kind).toBe("stood-down")
			expect(sent).toEqual([])
		}
	})

	it("stands down when the record carries no identity", async () => {
		const { ctx } = notesContext(inferred, answering(200), { records: [{ title: "first" }] })
		expect(crossTenantItemRead.plan(ctx)).toEqual({ needs: "a record that carries its identity", ok: false })
	})

	it("grades the entity's item read", () => {
		const entity = inferred.entities.get("note")
		expect(entity === undefined ? [] : crossTenantItemRead.subjects(entity, inferred)).toEqual(["readNote"])
	})
})
