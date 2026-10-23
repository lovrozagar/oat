/**
 * A server error is a failure wherever it shows up. Checks judge the answers they asked for, and a
 * check that needed an action to succeed before it could look at anything reports the failed
 * action as a gap in what it could verify. That is true of the check, and it leaves the 5xx itself
 * unreported. This pass closes that: after everything has run, every 5xx in the transcript that no
 * check already reported as a defect becomes one, on the operation that answered with it. A
 * document that lists 500 does not make a crash correct.
 */

import type { CheckId } from "./check-ids.ts"
import type { Check } from "./checks/core/check.ts"
import type { Exchange } from "./exchange.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import { describeServerError } from "./rate-limit/retry-after.ts"
import { headerValue } from "./headers.ts"
import type { GradeLedger } from "./grades.ts"
import type { SpecModel } from "../spec/graph/types.ts"
import { TARGET_VERSION_READ } from "./target-version.ts"

export const SERVER_ERROR_CHECK_ID: Extract<CheckId, "response.no-server-error"> = "response.no-server-error"

export const serverErrorCheck: Check = {
	id: SERVER_ERROR_CHECK_ID,
	needs: "a response from the backend",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Runs after every check, scenario, contract call and teardown. `reportServerErrors` does. */
	subjects: () => [],
}

/** Sequence numbers restart per client, so an exchange is named by where it went as well. */
function exchangeKey(exchange: Exchange): string {
	return `${exchange.seq}|${exchange.method}|${exchange.url}`
}

const EVIDENCE_PER_OPERATION = 3

/** What judging the run's server errors needs. */
export interface ServerErrorInput {
	checksRun: Set<string>
	findings: FindingCollector
	grades: GradeLedger
	/* A targeted run grades its targets only; a support call that crashed blocks them, and says so. */
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	/* Set when the host itself stopped answering: then a timeout is the outage, not the operation. */
	networkDown: boolean
	transcripts: ReadonlyArray<readonly Exchange[]>
}

export function reportServerErrors(input: ServerErrorInput): void {
	input.checksRun.add(SERVER_ERROR_CHECK_ID)
	for (const [key, exchanges] of unreported(input)) reportOperation(input, key, exchanges)
}

/** Every server error no check reported, by the operation that answered it (or its method and path). */
function unreported(input: ServerErrorInput): Map<string, Exchange[]> {
	const reported = new Set(
		input.findings.findings
			.filter((finding) => finding.verdict === "BACKEND_BUG" || finding.verdict === "SECURITY")
			.flatMap((finding) => finding.evidence.map(exchangeKey)),
	)
	const byOperation = new Map<string, Exchange[]>()
	for (const exchange of input.transcripts.flat()) {
		if (!isServerError(exchange, input.networkDown) || reported.has(exchangeKey(exchange))) continue
		if (exchange.operationId === undefined ? input.mode !== "full" : !input.inScope(exchange.operationId)) continue
		const key = exchange.operationId ?? `${exchange.method} ${new URL(exchange.url).pathname}`
		const seen = byOperation.get(key) ?? []
		seen.push(exchange)
		byOperation.set(key, seen)
	}
	return byOperation
}

/** A 5xx, or a timeout on a host that went on answering, outside the version read and not superseded. */
function isServerError(exchange: Exchange, networkDown: boolean): boolean {
	const timedOut = exchange.status === 0 && exchange.network?.kind === "timeout" && !networkDown
	if ((exchange.status < 500 && !timedOut) || exchange.superseded === true) return false
	return exchange.check !== TARGET_VERSION_READ
}

function reportOperation(input: ServerErrorInput, key: string, exchanges: Exchange[]): void {
	const op = input.model.byOperationId.get(key)
	const operations = op === undefined ? [] : [op.operationId]
	const statuses = [...new Set(exchanges.map((exchange) => exchange.status))].join(", ")
	const last = exchanges.at(-1) as Exchange
	if (op !== undefined) input.grades.graded(operations, SERVER_ERROR_CHECK_ID)
	input.findings
		.attributed(operations)
		.ownedBy(SERVER_ERROR_CHECK_ID)
		.backend(SERVER_ERROR_CHECK_ID, op?.entity ?? "run", {
			summary: `${key} ${describeServerError(last.status, headerValue(last.responseHeaders, "retry-after"))}`,
			detail:
				`${exchanges.length} request(s) to ${key} returned ${statuses}. A server error is a failure ` +
				"even where the document lists it, and even when the check that sent the request could " +
				"only report what it was then unable to verify.",
			evidence: exchanges.slice(0, EVIDENCE_PER_OPERATION),
		})
}
