import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { notesContext } from "./__fixtures__/context.ts"
import { notesDocument } from "./__fixtures__/notes.ts"
import { denialDoesNotRevealExistence } from "./tenant-denial-does-not-reveal-existence.ts"

const model = modelOf(notesDocument())

/** The other tenant's read: `real` for the owner's note, `absent` for any other id. */
const denying = (real: number, absent: number) => (_method: string, path: string) =>
	path === "/orgs/o2/notes/n1" ? { status: real } : { status: absent }

describe("tenant.denial-does-not-reveal-existence", () => {
	it("passes when a real and a never-issued id are refused alike", async () => {
		const { ctx, findings, sent } = notesContext(model, denying(404, 404))
		expect(await runCheck(denialDoesNotRevealExistence, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.path)).toEqual([
			"/orgs/o2/notes/n1",
			expect.stringMatching(/^\/orgs\/o2\/notes\/oat-absent-/),
		])
		/* Both as the peer, each named so the client sends the read's own credential. */
		expect(sent.map((s) => s.options)).toEqual([
			{ as: { principal: "other" }, operationId: "readNote" },
			{ as: { principal: "other" }, operationId: "readNote" },
		])
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY when the status tells an existing record from an absent one", async () => {
		const { ctx, findings } = notesContext(model, denying(403, 404))
		expect(await runCheck(denialDoesNotRevealExistence, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.summary).toBe("the denial status reveals whether a record exists")
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([403, 404])
	})

	it("is unresolved when either probe was served rather than denied", async () => {
		for (const [real, absent] of [
			[200, 404],
			[404, 200],
		] as const) {
			const { ctx } = notesContext(model, denying(real, absent))
			expect(await runCheck(denialDoesNotRevealExistence, ctx)).toEqual({
				kind: "unresolved",
				reason: "one of the two probes was not denied, so there is no pair of denials to compare",
			})
		}
	})
})

describe("tenant.denial-does-not-reveal-existence without a verdict", () => {
	it("asks under the owner's scope when the peer has none", async () => {
		const { ctx, sent } = notesContext(model, denying(404, 404), { peerScope: undefined })
		await runCheck(denialDoesNotRevealExistence, ctx)
		expect(sent[0]?.path).toBe("/orgs/o1/notes/n1")
	})

	it("is unresolved when the record carries no identity", async () => {
		const { ctx, sent } = notesContext(model, denying(404, 404), { records: [{ title: "first" }] })
		expect(await runCheck(denialDoesNotRevealExistence, ctx)).toEqual({
			kind: "unresolved",
			reason: 'the record carries no "id"',
		})
		expect(sent).toEqual([])
	})

	it("is unresolved when the identifier schema admits no id that names nothing", async () => {
		const enumerated = modelOf(notesDocument({ idSchema: { enum: ["n1", "n2"], type: "string" } }))
		const { ctx, sent } = notesContext(enumerated, denying(404, 404))
		expect((await runCheck(denialDoesNotRevealExistence, ctx)).kind).toBe("unresolved")
		expect(sent).toEqual([])
	})

	it("stands down without a second tenant, a read, a record or a boundary", async () => {
		const shared = modelOf(notesDocument({ tenant: false }))
		for (const { ctx } of [
			notesContext(model, denying(404, 404), { peer: undefined }),
			notesContext(model, denying(404, 404), { readOp: undefined }),
			notesContext(model, denying(404, 404), { records: [] }),
			notesContext(shared, denying(404, 404)),
		]) {
			expect((await runCheck(denialDoesNotRevealExistence, ctx)).kind).toBe("stood-down")
		}
	})
})
