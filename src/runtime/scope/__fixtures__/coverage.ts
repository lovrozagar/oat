import type { Exchange } from "../../exchange.ts"
import type { Finding, Inconclusive } from "../../finding.ts"
import { GradeLedger } from "../../grades.ts"
import { resolveTargetScope } from "../target.ts"
import type { CoverageInput } from "../types.ts"
import { payModel } from "./models.ts"

/** A call as the transcript holds it: what grading reads of an exchange. */
export function call(fields: Partial<Exchange> & { status: number }): Exchange {
	return {
		at: 0,
		durationMs: 0,
		method: "POST",
		requestBody: undefined,
		requestBytes: 0,
		requestHeaders: {},
		requestId: "r1",
		responseBody: null,
		responseBytes: 0,
		responseHeaders: {},
		seq: 1,
		url: "http://api.test/v1/pay",
		...fields,
	}
}

export function finding(verdict: Finding["verdict"], check: string, fields: Partial<Finding> = {}): Finding {
	return {
		check,
		detail: `${check} detail`,
		entity: "pay",
		evidence: [],
		operations: ["pay.start"],
		summary: `${check} summary`,
		verdict,
		...fields,
	}
}

/** The coverage of `pay.start` targeted on its own, from what the run recorded. */
export function coverageInput(fields: {
	ledger?: GradeLedger
	findings?: Finding[]
	inconclusive?: Inconclusive[]
	transcript?: Exchange[]
	ops?: string[]
}): CoverageInput {
	const model = payModel()
	return {
		authCreates: new Set(),
		baseUrl: "http://api.test",
		findings: fields.findings ?? [],
		inconclusive: fields.inconclusive ?? [],
		ledger: fields.ledger ?? new GradeLedger(),
		model,
		scope: resolveTargetScope(model, { ops: fields.ops ?? ["pay.start"] }),
		transcript: fields.transcript ?? [],
	}
}
