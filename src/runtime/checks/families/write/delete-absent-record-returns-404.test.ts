import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import type { Answer } from "../../__fixtures__/harness.ts"
import { GATED, notesContext, notesModel } from "./__fixtures__/notes.ts"
import { deleteMissingIs404 } from "./delete-absent-record-returns-404.ts"

/*
 * A DELETE of an id that was never created must say so: 404 (or 410, or a 400 for the shape). A
 * 2xx hides broken client state; a 5xx is a crash. Defect: delete-absent-200.
 */

async function deleteAnswered(answer: Answer) {
	const stage = notesContext(notesModel(), (method) => (method === "DELETE" ? answer : undefined))
	const outcome = await runCheck(deleteMissingIs404, stage.ctx)
	return { ...stage, outcome }
}

describe("delete.absent-record-returns-404", () => {
	it("passes a backend that answers a missing id with 404, 410 or 400", async () => {
		for (const status of [404, 410, 400]) {
			const { outcome, findings, sent } = await deleteAnswered({ status })
			expect(outcome.kind).toBe("asserted")
			expect(findings.findings).toEqual([])
			expect(sent).toHaveLength(1)
			expect(sent[0]?.method).toBe("DELETE")
			expect(sent[0]?.path).toMatch(/^\/notes\/.+/)
		}
	})

	it("fails a backend that reports success for a record that never existed", async () => {
		const { outcome, findings } = await deleteAnswered({ status: 204 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("deleting a nonexistent record reports success")
	})

	it("fails a backend that crashes on a missing id", async () => {
		const { outcome, findings } = await deleteAnswered({ status: 500 })
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("deleting a nonexistent record crashes")
	})

	it("is unresolved when the delete is refused for another reason", async () => {
		const { outcome } = await deleteAnswered({ status: 401 })
		expect(outcome.kind).toBe("unresolved")
	})

	it("stands down on a documented feature gate", async () => {
		const { outcome, findings } = await deleteAnswered(GATED)
		expect(outcome.kind).toBe("stood-down")
		expect(findings.findings[0]?.verdict).toBe("COVERAGE_GAP")
	})

	it("does not plan without a delete operation", () => {
		const { ctx } = notesContext(notesModel(), () => undefined, { deleteOp: undefined })
		expect(deleteMissingIs404.plan(ctx).ok).toBe(false)
	})

	it("does not plan when the identifier admits no absent value", () => {
		const { ctx } = notesContext(notesModel({ idSchema: { enum: ["only"], type: "string" } }), () => undefined)
		const planned = deleteMissingIs404.plan(ctx)
		expect(planned.ok).toBe(false)
		expect(planned.ok ? undefined : planned.needs).toBe("an identifier of the documented shape that names no record")
	})
})
