import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { GATED, notesContext, notesModel, notesServer } from "./__fixtures__/notes.ts"
import { immutableRejected } from "./patch-immutable-field-rejected.ts"

/*
 * A field the document declares `x-immutable` must refuse a write (400, 422 or 409). Defect:
 * immutable-accepted — the PATCH answers 200 and the new value persists.
 */

const MODEL = notesModel({ immutable: ["code"] })

/** A backend over `server`, with `override` answering first where it returns something. */
function backend(override: Responder = () => undefined, model = MODEL) {
	const server = notesServer()
	const moved: string[] = []
	const respond: Responder = (method, path, options) =>
		override(method, path, options) ?? server.respond(method, path, options)
	const stage = notesContext(model, respond, {
		recordMoved: (_entity, id, reason) => moved.push(`${id}: ${reason}`),
	})
	return { moved, server, ...stage }
}

const refusePatch: Responder = (method) => (method === "PATCH" ? { status: 422 } : undefined)

describe("patch.immutable-field-rejected verdicts", () => {
	it("passes a backend that refuses the write to the immutable field", async () => {
		const { ctx, findings, sent, moved } = backend(refusePatch)
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(moved).toEqual([])
		const patch = sent.find((s) => s.method === "PATCH")
		expect(patch?.path).toBe("/notes/n1")
		expect(Object.keys(patch?.options.body as object)).toEqual(["code"])
	})

	it("passes a backend that answers 2xx but keeps the stored value", async () => {
		const { ctx, findings, moved } = backend((method) => (method === "PATCH" ? { status: 204 } : undefined))
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		/* An accepted write to a key may still have moved the record. */
		expect(moved).toEqual(['n1: moved by a write to "code" the backend accepted (note.update)'])
	})

	it("fails a backend that echoes the new value", async () => {
		const { ctx, findings } = backend()
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a field declared immutable accepted a write")
		expect(findings.findings[0]?.detail).toContain('PATCH set "code"')
	})

	it("fails a backend whose read shows the new value though the answer did not echo it", async () => {
		const { ctx, findings, server } = backend((method, path, options) => {
			if (method !== "PATCH") return undefined
			server.respond(method, path, options)
			return { status: 204 }
		})
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.evidence.map((e) => e.method)).toEqual(["PATCH", "GET"])
	})

	it("fails a backend whose read after the write is not a record", async () => {
		const { ctx } = backend((method) => (method === "GET" ? { status: 404 } : undefined))
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("reports a crash on the write", async () => {
		const { ctx, findings } = backend((method) => (method === "PATCH" ? { status: 500 } : undefined))
		expect(await runCheck(immutableRejected, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a request that should be refused drew a server error")
	})
})

describe("patch.immutable-field-rejected without a verdict", () => {
	it("stands down when the update is behind a documented feature gate", async () => {
		const { ctx } = backend((method) => (method === "PATCH" ? GATED : undefined))
		expect((await runCheck(immutableRejected, ctx)).kind).toBe("stood-down")
	})

	it("is unresolved when no record can be made", async () => {
		const { ctx, sent } = backend((method) => (method === "POST" ? { status: 500 } : undefined))
		expect((await runCheck(immutableRejected, ctx)).kind).toBe("unresolved")
		expect(sent.some((s) => s.method === "PATCH")).toBe(false)
	})

	it("is unresolved when no other value for the field can be made", async () => {
		const { ctx, sent } = backend(refusePatch, notesModel({ immutable: ["ghost"] }))
		const outcome = await runCheck(immutableRejected, ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: 'no other valid value for "ghost" can be made' })
		expect(sent.some((s) => s.method === "PATCH")).toBe(false)
	})
})

describe("patch.immutable-field-rejected plan", () => {
	it("probes a field other than the identity, and the identity only when it is the sole one", () => {
		const both = backend(refusePatch, notesModel({ immutable: ["id", "code"] })).ctx
		const planned = immutableRejected.plan(both)
		expect(planned.ok && planned.value.field).toBe("code")
		const only = backend(refusePatch, notesModel({ immutable: ["id"] })).ctx
		const alone = immutableRejected.plan(only)
		expect(alone.ok && alone.value.field).toBe("id")
	})

	it("does not plan without an immutable field, an update, a read or a create", () => {
		const none = backend(refusePatch, notesModel()).ctx
		expect(immutableRejected.plan(none).ok).toBe(false)
		const ready = backend().ctx
		expect(immutableRejected.plan({ ...ready, updateOp: undefined }).ok).toBe(false)
		expect(immutableRejected.plan({ ...ready, readOp: undefined }).ok).toBe(false)
		expect(immutableRejected.plan({ ...ready, createOp: undefined }).ok).toBe(false)
	})
})
