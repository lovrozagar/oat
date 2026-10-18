import { describe, expect, it } from "vitest"
import type { ReadClient } from "../../../client/client.ts"
import { ASSERTED } from "../../finding.ts"
import { exchange } from "../__fixtures__/harness.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import { asProbe, judgeRefusal } from "./refusal.ts"

/*
 * A request sent to be refused asserts its property only when refused for that reason. A crash is
 * a finding; any other refusal turned it away before the input was considered, so nothing was
 * learned; an acceptance is left to the caller.
 */

const answered = (status: number) => exchange("POST", "/notes", { status })

describe("judgeRefusal", () => {
	it("leaves an accepted request to the caller", () => {
		const { ctx, findings } = notesContext()
		expect(judgeRefusal(ctx, "validation.required-enforced", ["validation"], answered(201))).toBeNull()
		expect(findings.findings).toEqual([])
	})

	it("asserts the property on the statuses that mean refused for the reason given", () => {
		const { ctx, findings } = notesContext()
		expect(judgeRefusal(ctx, "c", ["validation"], answered(400))).toBe(ASSERTED)
		expect(judgeRefusal(ctx, "c", ["validation"], answered(422))).toBe(ASSERTED)
		expect(judgeRefusal(ctx, "c", ["conflict"], answered(409))).toBe(ASSERTED)
		expect(judgeRefusal(ctx, "c", ["content-type", "validation"], answered(415))).toBe(ASSERTED)
		expect(findings.findings).toEqual([])
	})

	it("files a crash as a backend bug naming what it should have answered", () => {
		const { ctx, findings } = notesContext()
		const crash = answered(500)
		expect(judgeRefusal(ctx, "c", ["conflict", "validation"], crash)).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(findings.findings).toHaveLength(1)
		expect(findings.findings[0]).toMatchObject({
			check: "c",
			entity: "note",
			evidence: [crash],
			summary: "a request that should be refused drew a server error",
		})
		expect(findings.findings[0]?.detail).toContain(
			"returned 500; invalid input should be refused with 409 or 400 or 422",
		)
	})

	it("is unresolved for a refusal that is not about the input, or for no answer", () => {
		const { ctx, findings } = notesContext()
		expect(judgeRefusal(ctx, "c", ["validation"], answered(409))).toMatchObject({ kind: "unresolved" })
		expect(judgeRefusal(ctx, "c", ["validation"], answered(403))).toMatchObject({
			reason: "the probe was turned away with 403, which does not say the input itself was refused",
		})
		expect(judgeRefusal(ctx, "c", ["validation"], answered(0))).toMatchObject({ kind: "unresolved" })
		expect(findings.inconclusive).toHaveLength(3)
		expect(findings.findings).toEqual([])
	})
})

describe("asProbe", () => {
	it("sends through a view of the client marked as a probe, leaving the rest of the context", () => {
		const { ctx } = notesContext()
		const views: unknown[] = []
		const probeClient = { marked: true }
		const client = { ...ctx.client, view: (options: unknown) => (views.push(options), probeClient) }
		const probing = asProbe({ ...ctx, client: client as unknown as ReadClient })
		expect(probing.client).toBe(probeClient)
		expect(views).toEqual([{ purpose: "probe" }])
		expect(probing.listOp).toBe(ctx.listOp)
	})
})
