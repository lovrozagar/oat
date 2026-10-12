import { describe, expect, it } from "vitest"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { buildScopeReport, GradeLedger, resolveTargetScope } from "../src/runtime/scope.ts"

const doc = {
	info: { title: "vacuous", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/pay": { post: { operationId: "pay.start", responses: { "200": { description: "ok" } } } },
	},
} as unknown as OpenApiDocument

function report(ledger: GradeLedger, transcript: unknown[], blocked = false) {
	const model = buildModel(doc)
	return buildScopeReport({
		authCreates: new Set(),
		baseUrl: "http://api.test",
		findings: blocked
			? [
					{
						check: "scenario.pay",
						detail: "blocked by scenario stopped at step 2",
						entity: "pay",
						evidence: [],
						operations: ["pay.start"],
						summary: "scenario stopped",
						verdict: "BLOCKED",
					},
				]
			: [],
		inconclusive: [],
		ledger,
		model,
		scope: resolveTargetScope(model, { ops: ["pay.start"] }),
		transcript: transcript as never,
	}).operations[0]
}

describe("a pass needs a call", () => {
	it("does not count a check that graded an operation it never called", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		const row = report(ledger, [])
		expect(row?.status).toBe("untested")
		expect(row?.reason).toContain("no request to pay.start succeeded")
	})

	it("keeps a block when the only pass came from a check that never called it", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		expect(report(ledger, [], true)?.status).toBe("blocked")
	})

	it("passes once a successful call exists", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		const call = { method: "POST", operationId: "pay.start", seq: 1, status: 200, url: "http://api.test/v1/pay" }
		expect(report(ledger, [call])?.status).toBe("passed")
	})
})
