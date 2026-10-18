import { describe, expect, it, vi } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import * as read from "../../sets/read.ts"
import { GATED, notesContext, notesModel, notesServer } from "./__fixtures__/notes.ts"
import { softDeleteHidden } from "./softdelete-absent-from-default-list.ts"

/*
 * A record deleted under `x-soft-delete` is a tombstone: the default listing must not return it.
 * Defect: softdelete-leaks — the delete answers 204 and the record stays in the list.
 */

vi.mock("../../sets/read.ts", async (importActual) => {
	const actual = await importActual<typeof read>()
	return { ...actual, readSet: vi.fn(actual.readSet) }
})

const MODEL = notesModel({ softDelete: "deleted_at" })

/** A correct backend, with `override` answering first where it returns something. */
function backend(override: Responder = () => undefined) {
	const server = notesServer()
	const respond: Responder = (method, path, options) =>
		override(method, path, options) ?? server.respond(method, path, options)
	return { server, ...notesContext(MODEL, respond, { softDelete: "deleted_at" }) }
}

describe("softdelete.absent-from-default-list verdicts", () => {
	it("passes a backend whose default listing drops the deleted record", async () => {
		const { ctx, findings, sent } = backend()
		expect(await runCheck(softDeleteHidden, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /notes", "DELETE /notes/n1", "GET /notes"])
	})

	it("fails a backend that tombstones the record but still lists it", async () => {
		const { ctx, findings } = backend((method) => (method === "DELETE" ? { status: 204 } : undefined))
		expect(await runCheck(softDeleteHidden, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("soft-deleted record still appears in the default listing")
		expect(findings.findings[0]?.detail).toContain('tombstoned via "deleted_at"')
		expect(findings.findings[0]?.evidence.map((e) => e.method)).toEqual(["DELETE", "GET"])
	})
})

describe("softdelete.absent-from-default-list without a verdict", () => {
	it("is unresolved when no record can be made to delete", async () => {
		const { ctx } = backend((method) => (method === "POST" ? { status: 500 } : undefined))
		const outcome = await runCheck(softDeleteHidden, ctx)
		expect(outcome.kind).toBe("unresolved")
	})

	it("stands down when the delete is behind a documented feature gate", async () => {
		const { ctx } = backend((method) => (method === "DELETE" ? GATED : undefined))
		expect((await runCheck(softDeleteHidden, ctx)).kind).toBe("stood-down")
	})

	it("is unresolved when the delete is refused", async () => {
		const { ctx } = backend((method) => (method === "DELETE" ? { status: 409 } : undefined))
		const outcome = await runCheck(softDeleteHidden, ctx)
		expect(outcome).toEqual({
			kind: "unresolved",
			reason: "DELETE returned 409, so no tombstone was created to look for",
		})
	})

	it("is unresolved when the listing is refused after the delete", async () => {
		const { ctx } = backend((method, path) => (method === "GET" && path === "/notes" ? { status: 500 } : undefined))
		const outcome = await runCheck(softDeleteHidden, ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: "page 1 was answered with 500" })
	})

	it("names a rejected listing even when the read gives no reason", async () => {
		const { ctx } = backend()
		vi.mocked(read.readSet).mockResolvedValueOnce({
			complete: false,
			items: [],
			last: { envelope: undefined, exchange: undefined, items: [] } as never,
			pages: [],
			status: "unresolved",
		})
		const outcome = await runCheck(softDeleteHidden, ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: "the listing was rejected" })
	})

	it("is unresolved when the record is absent from a listing the read could not cover", async () => {
		const crowd = Array.from({ length: 500 }, (_, index) => ({ id: `other-${index}`, name: "x" }))
		const { ctx } = backend((method, path) =>
			method === "GET" && path === "/notes" ? { body: crowd, status: 200 } : undefined,
		)
		const outcome = await runCheck(softDeleteHidden, ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: "the listing is larger than a read covers" })
	})
})

describe("softdelete.absent-from-default-list plan", () => {
	it("plans only with a create, a delete and x-soft-delete", () => {
		const ready = backend().ctx
		expect(softDeleteHidden.plan(ready).ok).toBe(true)
		expect(softDeleteHidden.plan({ ...ready, softDelete: null }).ok).toBe(false)
		expect(softDeleteHidden.plan({ ...ready, deleteOp: undefined }).ok).toBe(false)
		expect(softDeleteHidden.plan({ ...ready, createOp: undefined }).ok).toBe(false)
	})
})
