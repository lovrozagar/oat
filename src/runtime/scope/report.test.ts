import { describe, expect, it } from "vitest"
import { GradeLedger } from "../grades.ts"
import { call, coverageInput, finding } from "./__fixtures__/coverage.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { buildScopeReport } from "./report.ts"
import { resolveTargetScope } from "./target.ts"

const graded = (): GradeLedger => {
	const ledger = new GradeLedger()
	ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
	return ledger
}

describe("a pass needs a call", () => {
	it("does not count a check that graded an operation it never called", () => {
		const row = buildScopeReport(coverageInput({ ledger: graded() })).operations[0]
		expect(row?.status).toBe("untested")
		expect(row?.reason).toContain("no request to pay.start succeeded")
		expect(row?.why).toBe(row?.reason)
	})

	it("keeps a block when the only pass came from a check that never called it", () => {
		const input = coverageInput({ findings: [finding("BLOCKED", "scenario.pay")], ledger: graded() })
		expect(buildScopeReport(input).operations[0]?.status).toBe("blocked")
	})

	it("passes once a successful call exists, and says how far the pass goes", () => {
		const call200 = call({ operationId: "pay.start", status: 200 })
		const row = buildScopeReport(coverageInput({ ledger: graded(), transcript: [call200] })).operations[0]
		expect(row).toMatchObject({ entity: null, findings: 0, reason: null, status: "passed" })
		expect(row?.tier).toBeUndefined()
		const ledger = graded()
		ledger.prove("pay.start", { call: 1 })
		expect(buildScopeReport(coverageInput({ ledger, transcript: [call200] })).operations[0]).toMatchObject({
			evidence: { call: 1 },
			sufficiency: "unproven",
			tier: "contract",
		})
		const observed = graded()
		observed.prove("pay.start", { call: 1, observation: { seq: 2, status: 404 } })
		expect(buildScopeReport(coverageInput({ ledger: observed, transcript: [call200] })).operations[0]).toMatchObject({
			sufficiency: "verified",
			tier: "verified",
			why: "a later exchange shows what this call did",
		})
	})
})

describe("buildScopeReport", () => {
	it("covers every operation in a full run, with no support", () => {
		const model = referenceModel()
		const report = buildScopeReport({
			...coverageInput({}),
			model,
			scope: resolveTargetScope(model, {}),
		})
		expect(report.mode).toBe("full")
		expect(report.operations).toHaveLength(model.operations.length)
		expect(report.support).toEqual([])
		expect(report.originsSkipped).toEqual([])
	})

	it("counts the calls a targeted run made to what it did not target", () => {
		const model = referenceModel()
		const transcript = [
			call({ method: "GET", operationId: "table.list", status: 200, url: "http://api.test/v1/projects/p/tables" }),
			call({ method: "POST", status: 500, requestId: "r2", url: "http://api.test/v1/projects/p/tables" }),
			call({ method: "POST", status: 409, requestId: "r3", url: "http://api.test/v1/projects/p/tables" }),
			call({ method: "GET", status: 200, url: "http://api.test/v1/projects/p/tables/t" }),
			call({ method: "GET", status: 200, url: "http://api.test/elsewhere" }),
			call({ method: "GET", operationId: "gone", status: 200, url: "http://api.test/v1/projects/p/tables/t" }),
			call({ method: "GET", status: 101, url: "http://api.test/v1/projects/p/tables" }),
		]
		const report = buildScopeReport({
			...coverageInput({}),
			model,
			scope: resolveTargetScope(model, { ops: ["table.get"] }),
			transcript,
		})
		expect(report.support).toEqual([
			{ calls: 2, firstFailure: { requestId: "r2", status: 500 }, non2xx: 2, operationId: "table.create" },
			{ calls: 2, firstFailure: { requestId: "r1", status: 101 }, non2xx: 1, operationId: "table.list" },
		])
	})
})
