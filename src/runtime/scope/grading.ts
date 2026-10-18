/** What the run's findings, ledger and transcript say about one operation. */

import type { Finding } from "../finding.ts"
import { operationFor } from "./operation-for.ts"
import type { CoverageInput, OperationStatus } from "./types.ts"

const NOT_DEFECTS: ReadonlySet<string> = /* @__PURE__ */ new Set(["COVERAGE_GAP", "BLOCKED"])

/** One operation's checks, sorted by how each ended. */
export interface Grading {
	defects: Finding[]
	blocked: Finding[]
	failed: string[]
	inconclusive: string[]
	ran: Set<string>
	gapFindings: Finding[]
	gaps: string[]
	/** A request reached the operation and succeeded. */
	succeeded: boolean
	passed: string[]
	suppressed: string[]
	status: OperationStatus
}

function statusOf(passed: number, failed: number, inconclusive: number, blocked: boolean): OperationStatus {
	if (failed > 0) return "failed"
	if (passed > 0) return "passed"
	if (inconclusive > 0) return "inconclusive"
	return blocked ? "blocked" : "untested"
}

/* A pass rests on a request that reached this operation and succeeded. A check that graded it
 * without one (a rate-limit or bookkeeping check over a route nothing called) proves nothing. */
function succeededOn(input: CoverageInput, operationId: string): boolean {
	return input.transcript.some(
		(exchange) =>
			exchange.status >= 200 &&
			exchange.status < 400 &&
			(exchange.operationId ?? operationFor(input.model, exchange.method, exchange.url, input.baseUrl)?.operationId) ===
				operationId,
	)
}

export function gradingOf(input: CoverageInput, operationId: string): Grading {
	const { ledger } = input
	const mine = (attributed: string[] | undefined): boolean => attributed?.includes(operationId) === true
	const defects = input.findings.filter((f) => mine(f.operations) && !NOT_DEFECTS.has(f.verdict))
	const blocked = input.findings.filter((f) => mine(f.operations) && f.verdict === "BLOCKED")
	const failed = [...new Set(defects.map((f) => f.check))].sort()
	const inconclusive = [...new Set(input.inconclusive.filter((i) => mine(i.operations)).map((i) => i.check))]
		.filter((check) => !failed.includes(check))
		.sort()
	const ran = ledger.ran.get(operationId) ?? new Set<string>()
	const gapFindings = input.findings.filter(
		(f) => mine(f.operations) && f.verdict === "COVERAGE_GAP" && ran.has(f.check),
	)
	const gaps = [...new Set(gapFindings.map((f) => f.check))].filter((check) => !failed.includes(check)).sort()
	const succeeded = succeededOn(input, operationId)
	const passed = succeeded
		? [...ran]
				.filter((check) => !failed.includes(check) && !inconclusive.includes(check) && !gaps.includes(check))
				.sort()
		: []
	const suppressed = [...(ledger.suppressed.get(operationId) ?? [])].sort()
	const status = statusOf(
		passed.length,
		failed.length,
		inconclusive.length,
		suppressed.length > 0 || blocked.length > 0,
	)
	return { blocked, defects, failed, gapFindings, gaps, inconclusive, passed, ran, status, succeeded, suppressed }
}
