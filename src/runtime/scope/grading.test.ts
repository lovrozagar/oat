import { describe, expect, it } from "vitest"
import { GradeLedger } from "../grades.ts"
import { call, coverageInput, finding } from "./__fixtures__/coverage.ts"
import { gradingOf } from "./grading.ts"

const ledgerOf = (...checks: string[]): GradeLedger => {
	const ledger = new GradeLedger()
	for (const check of checks) ledger.graded(["pay.start"], check)
	return ledger
}

/* A finding attributed to no operation. */
const { operations: _operations, ...unattributed } = finding("BACKEND_BUG", "unattributed")

describe("gradingOf", () => {
	it("passes the checks that ran once a call succeeded, sorted", () => {
		const grading = gradingOf(
			coverageInput({
				ledger: ledgerOf("b.check", "a.check"),
				transcript: [call({ operationId: "pay.start", status: 200 })],
			}),
			"pay.start",
		)
		expect(grading).toMatchObject({ passed: ["a.check", "b.check"], status: "passed", succeeded: true })
	})

	it("counts a call by its URL when it names no operation, and never a failed one", () => {
		expect(
			gradingOf(coverageInput({ ledger: ledgerOf("a.check"), transcript: [call({ status: 302 })] }), "pay.start")
				.succeeded,
		).toBe(true)
		expect(gradingOf(coverageInput({ transcript: [call({ status: 500 })] }), "pay.start").succeeded).toBe(false)
		expect(gradingOf(coverageInput({ transcript: [call({ status: 101 })] }), "pay.start").succeeded).toBe(false)
		expect(
			gradingOf(coverageInput({ transcript: [call({ status: 200, url: "http://api.test/v1/other" })] }), "pay.start")
				.succeeded,
		).toBe(false)
	})
})

describe("gradingOf, short of a pass", () => {
	it("fails on a defect, and keeps a failed check out of the rest", () => {
		const grading = gradingOf(
			coverageInput({
				findings: [
					finding("BACKEND_BUG", "a.check"),
					finding("BACKEND_BUG", "a.check"),
					finding("COVERAGE_GAP", "a.check"),
					finding("BACKEND_BUG", "elsewhere", { operations: ["other.op"] }),
					unattributed,
				],
				inconclusive: [{ check: "a.check", entity: "pay", operations: ["pay.start"], reason: "r" }],
				ledger: ledgerOf("a.check"),
			}),
			"pay.start",
		)
		expect(grading).toMatchObject({ failed: ["a.check"], gaps: [], inconclusive: [], status: "failed" })
		expect(grading.defects).toHaveLength(2)
	})

	it("is inconclusive, a gap, blocked, suppressed or untested short of a pass", () => {
		const inconclusive = gradingOf(
			coverageInput({
				inconclusive: [
					{ check: "b.check", entity: "pay", operations: ["pay.start"], reason: "r" },
					{ check: "z.check", entity: "pay", reason: "unattributed" },
				],
			}),
			"pay.start",
		)
		expect(inconclusive).toMatchObject({ inconclusive: ["b.check"], status: "inconclusive" })
		const gap = gradingOf(
			coverageInput({
				findings: [finding("COVERAGE_GAP", "a.check"), finding("COVERAGE_GAP", "unran.check")],
				ledger: ledgerOf("a.check"),
			}),
			"pay.start",
		)
		expect(gap).toMatchObject({ gaps: ["a.check"], status: "untested" })
		expect(gap.gapFindings).toHaveLength(1)
		expect(gradingOf(coverageInput({ findings: [finding("BLOCKED", "s.pay")] }), "pay.start").status).toBe("blocked")
		const ledger = new GradeLedger()
		ledger.suppress(["pay.start"], "y.check")
		ledger.suppress(["pay.start"], "x.check")
		expect(gradingOf(coverageInput({ ledger }), "pay.start")).toMatchObject({
			status: "blocked",
			suppressed: ["x.check", "y.check"],
		})
		expect(gradingOf(coverageInput({}), "pay.start").status).toBe("untested")
	})
})
