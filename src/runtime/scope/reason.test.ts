import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { GradeLedger } from "../grades.ts"
import { call, coverageInput, finding } from "./__fixtures__/coverage.ts"
import { gradingOf } from "./grading.ts"
import { reasonFor } from "./reason.ts"
import type { CoverageInput } from "./types.ts"

function reason(input: CoverageInput, inScope = false): string | null {
	const op = input.model.byOperationId.get("pay.start") as OperationModel
	return reasonFor(input, { grading: gradingOf(input, "pay.start"), inScope, op })
}

/* The same input with no reason the scope settled in advance. */
const unsettled = (input: CoverageInput): CoverageInput => ({
	...input,
	scope: { ...input.scope, untestable: new Map() },
})

const needing = (...needs: string[]): GradeLedger => {
	const ledger = new GradeLedger()
	for (const need of needs) ledger.skipped(["pay.start"], need)
	return ledger
}

describe("reasonFor", () => {
	it("has none for a graded operation", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "a.check")
		expect(reason(coverageInput({ ledger, transcript: [call({ operationId: "pay.start", status: 200 })] }))).toBeNull()
		expect(reason(coverageInput({ findings: [finding("BACKEND_BUG", "a.check")] }))).toBeNull()
	})

	it("says what blocked it, or which earlier failure suppressed it", () => {
		expect(reason(coverageInput({ findings: [finding("BLOCKED", "s.pay", { detail: "blocked at step 2" })] }))).toBe(
			"blocked at step 2",
		)
		const ledger = new GradeLedger()
		ledger.suppress(["pay.start"], "x.check")
		expect(reason(coverageInput({ ledger }))).toBe("suppressed by an earlier failure (x.check)")
	})

	it("says checks graded it but no call to it succeeded", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "a.check")
		expect(reason(coverageInput({ ledger }))).toBe("graded by checks, but no request to pay.start succeeded")
	})

	it("prefers an empty list, then what the call tried with the static reason, then each alone", () => {
		expect(reason(coverageInput({ ledger: needing("the list returned no id", "contract call failed") }))).toBe(
			"the list returned no id",
		)
		expect(reason(coverageInput({ ledger: needing("contract call failed") }))).toBe(
			"unmodeled: no entity owns POST /v1/pay; contract call failed",
		)
		expect(reason(unsettled(coverageInput({ ledger: needing("unresolved token") })), true)).toBe("unresolved token")
		expect(reason(unsettled(coverageInput({})))).toBe("unmodeled: no entity owns POST /v1/pay")
	})

	it("takes the static reason the scope already gave", () => {
		const input = coverageInput({})
		const scope = { ...input.scope, untestable: new Map([["pay.start", "unmodeled: no entity owns it"]]) }
		expect(reason({ ...input, scope }, true)).toBe("unmodeled: no entity owns it")
	})

	it("falls back to a coverage gap, then what the checks needed, then nothing at all", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "a.check")
		const gap = coverageInput({
			findings: [finding("COVERAGE_GAP", "a.check", { summary: "no peer" })],
			ledger,
			transcript: [call({ operationId: "pay.start", status: 200 })],
		})
		expect(reason(unsettled(gap), true)).toBe("coverage gap: no peer")
		expect(reason(unsettled(coverageInput({ ledger: needing("a", "b", "c", "d") })), true)).toBe(
			"no check applied: needs a; b; c",
		)
		expect(reason(unsettled(coverageInput({})), true)).toBe("no check exercised it")
	})
})
