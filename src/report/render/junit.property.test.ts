import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { GradeLedger } from "../../runtime/grades.ts"
import type { Exchange } from "../../runtime/exchange.ts"
import { type Finding, isFailingRootCause, type Verdict } from "../../runtime/finding.ts"
import { gradingOf } from "../../runtime/scope/grading.ts"
import type { CoverageInput } from "../../runtime/scope/types.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { finding, operation, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { renderJunit } from "./junit.ts"

/*
 * A check graded failed always has a finding on record: the scope report and the JUnit cases read
 * the same findings, so no case ever falls back to "no finding on record", and the failures are
 * exactly the (operation, check) pairs the exit code counts. A secondary origin is graded in its own
 * run before its findings join the primary's, so the same holds per origin.
 */

const OPERATIONS = ["row.list", "row.get"] as const
const CHECKS = ["sort.order-is-applied", "filter.eq-matches", "read.after-create"] as const
const VERDICTS: Verdict[] = ["BACKEND_BUG", "SPEC_BUG", "SECURITY", "AMBIGUITY", "COVERAGE_GAP", "BLOCKED"]

const findingArb = fc.record({
	check: fc.constantFrom(...CHECKS),
	known: fc.boolean(),
	operations: fc.subarray([...OPERATIONS], { minLength: 1 }),
	verdict: fc.constantFrom(...VERDICTS),
})

function inputOf(findings: readonly Finding[]): CoverageInput {
	const ledger = new GradeLedger()
	for (const id of OPERATIONS) ledger.ran.set(id, new Set(CHECKS))
	const answered = OPERATIONS.map((operationId) => ({ operationId, status: 200 }) as Exchange)
	return {
		authCreates: new Set(),
		baseUrl: "http://api.test",
		findings,
		inconclusive: [],
		ledger,
		model: {} as SpecModel,
		scope: { mode: "full" } as CoverageInput["scope"],
		transcript: answered,
	}
}

describe("renderJunit over graded operations", () => {
	it("fails exactly the graded pairs a counted finding names, and never lacks a finding for one", () => {
		fc.assert(
			fc.property(fc.array(findingArb, { maxLength: 8 }), (drawn) => {
				const findings = drawn.map(({ known, ...rest }) =>
					finding({ ...rest, ...(known ? { known: { reason: "accepted" } } : {}) }),
				)
				const operations = OPERATIONS.map((operationId) => {
					const { status: _status, ...checks } = gradingOf(inputOf(findings), operationId)
					return operation({ checks, operationId })
				})
				const xml = renderJunit(reportOf({ findings, scope: scopeOf({ operations }) }))
				const counted = new Set(
					findings
						.filter(isFailingRootCause)
						.flatMap((f) => (f.operations ?? []).map((operationId) => `${operationId} ${f.check}`)),
				)
				const failed = [...xml.matchAll(/<testcase classname="([^"]+)" name="([^"]+)"[^>]*>\s*<failure/g)].map(
					([, classname, name]) => `${classname} ${name}`,
				)
				expect(xml).not.toContain("no finding on record")
				expect(new Set(failed)).toEqual(counted)
			}),
		)
	})
})
