import { Client } from "../../../client/client.ts"
import { buildSpec } from "../../../reference/spec/build.ts"
import type { Exchange } from "../../../runtime/exchange.ts"
import type { Finding } from "../../../runtime/finding.ts"
import type { OperationCoverage, ScopeReport } from "../../../runtime/scope.ts"
import { Redactor } from "../../../security/redact.ts"
import { buildModel } from "../../../spec/graph/build.ts"
import { dereference } from "../../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { ReportInput } from "../input.ts"

/* Report inputs built by hand: a real client and the reference's model, with every field a test sets. */

export const BASE = "http://h.test"

export function exchange(over: Partial<Exchange> = {}): Exchange {
	return {
		at: 0,
		durationMs: 0,
		method: "GET",
		requestBody: undefined,
		requestBytes: 0,
		requestHeaders: {},
		requestId: "",
		responseBody: null,
		responseBytes: 0,
		responseHeaders: {},
		seq: 1,
		status: 200,
		url: `${BASE}/v1/rows`,
		...over,
	}
}

export function finding(over: Partial<Finding> = {}): Finding {
	return {
		check: "sort.order-is-applied",
		detail: "d",
		entity: "row",
		evidence: [],
		summary: "s",
		verdict: "BACKEND_BUG",
		...over,
	}
}

/** A report over `transcript`, with what `over` sets. */
export function reportOf(over: Partial<ReportInput> = {}, transcript: Exchange[] = []): ReportInput {
	const client = new Client({ baseUrl: BASE, redactor: new Redactor() })
	client.transcript.push(...transcript)
	return {
		baseUrl: BASE,
		checksRun: ["sort.order-is-applied"],
		client,
		durationMs: 1500,
		entitiesTested: ["row"],
		findings: [],
		model: buildModel(dereference(buildSpec() as OpenApiDocument).doc),
		startedAt: new Date(0),
		...over,
	}
}

export function operation(over: Partial<OperationCoverage> = {}): OperationCoverage {
	return {
		checks: { failed: [], gaps: [], inconclusive: [], passed: [], suppressed: [] },
		entity: "row",
		findings: 0,
		operationId: "row.list",
		reason: null,
		status: "passed",
		...over,
	}
}

export function scopeOf(over: Partial<ScopeReport> = {}): ScopeReport {
	return {
		excluded: [],
		mode: "full",
		operations: [operation()],
		originsSkipped: [],
		requested: { only: [], ops: [] },
		support: [],
		...over,
	}
}
