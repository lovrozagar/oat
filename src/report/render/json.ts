import { describeRequestBody, type Exchange } from "../../runtime/exchange.ts"
import { EXIT, runVerdict } from "../../runtime/exit.ts"
import type { Finding } from "../../runtime/finding.ts"
import { presentHeader } from "../../runtime/headers.ts"
import type { Redactor } from "../../security/redact.ts"
import { coverageByCheck } from "./coverage.ts"
import type { ReportInput } from "./input.ts"
import { costByCheck, latency, utf8Total } from "./traffic.ts"
import { byVerdict } from "./verdicts.ts"

function evidenceJson(exchange: Exchange, redactor: Redactor): Record<string, unknown> {
	/* A secret the response issues may sit in the request or URL rendered first. */
	redactor.learn(exchange.responseBody)
	return {
		at: new Date(exchange.at).toISOString(),
		durationMs: exchange.durationMs,
		method: exchange.method,
		requestBody: redactor.body(
			describeRequestBody(exchange.requestBody),
			presentHeader(exchange.requestHeaders, "content-type") ?? "",
		),
		requestBytes: exchange.requestBytes,
		requestId: exchange.requestId,
		responseBody: redactor.body(exchange.responseBody, presentHeader(exchange.responseHeaders, "content-type") ?? ""),
		responseBytes: exchange.responseBytes,
		status: exchange.status,
		url: redactor.url(exchange.url),
	}
}

function findingJson(finding: Finding, redactor: Redactor): Record<string, unknown> {
	return {
		check: finding.check,
		detail: finding.detail,
		entity: finding.entity,
		...(finding.origin === undefined ? {} : { origin: finding.origin }),
		...(finding.fixture === undefined ? {} : { fixture: finding.fixture }),
		...(finding.operations === undefined ? {} : { operations: finding.operations }),
		...(finding.known === undefined ? {} : { known: finding.known }),
		evidence: finding.evidence.map((exchange) => evidenceJson(exchange, redactor)),
		summary: finding.summary,
		verdict: finding.verdict,
	}
}

/** The verdict, and what the run did and did not check. */
function runJson(input: ReportInput): Record<string, unknown> {
	const { outcome, reason } = runVerdict(input)
	return {
		backend: input.baseUrl,
		/* The same verdict the process exit code states. */
		outcome: { exitCode: EXIT[outcome], reason, result: outcome },
		checksRun: input.checksRun,
		checksSkipped: input.checksSkipped ?? [],
		checksSuppressed: input.checksSuppressed ?? [],
		inconclusive: input.inconclusive ?? [],
		profile: input.profile ?? "full",
		profileExclusions: input.profileExclusions ?? [],
		...(input.scope === undefined ? {} : { scope: input.scope }),
		checksOutOfScope: input.checksOutOfScope ?? [],
		durationMs: input.durationMs,
		entitiesTested: input.entitiesTested,
		...(input.teardown === undefined || input.teardown === null ? {} : { teardown: input.teardown }),
	}
}

/** When it ran, and the circumstances a reader needs to trust it: network, interruption, baseline, build, fence. */
function contextJson(input: ReportInput, redactor: Redactor): Record<string, unknown> {
	return {
		generatedAt: input.startedAt.toISOString(),
		requests: input.client.transcript.length,
		...(input.network === undefined ? {} : { network: input.network }),
		...(input.interrupted === true ? { interrupted: true } : {}),
		...(input.baseline === undefined ? {} : { baseline: input.baseline }),
		...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
		...(input.fenced === undefined
			? {}
			: {
					fenced: {
						failRun: input.fenced.failRun,
						requests: input.fenced.requests.map((request) => ({ ...request, url: redactor.url(request.url) })),
					},
				}),
	}
}

/** What the run cost and observed, the findings per severity, and the coverage it fell short of. */
function tallyJson(input: ReportInput): Record<string, unknown> {
	const coverage = coverageByCheck(input)
	return {
		requestBytes: utf8Total(input.client.transcript, "request"),
		responseBytes: utf8Total(input.client.transcript, "response"),
		latency: latency(input.client.transcript),
		costByCheck: costByCheck(input),
		observed: input.checkNotes ?? [],
		summary: Object.fromEntries(byVerdict(input.findings).map(([verdict, group]) => [verdict, group.length])),
		coverage: {
			neverApplied: coverage.never.map((row) => row.check),
			partial: coverage.partialSkip.map((row) => ({ check: row.check, ran: row.ran, skipped: row.skipped })),
		},
	}
}

/**
 * The shape version of `oat-report.json` and `matrix.json`. It rises only on a breaking change to a
 * file's shape; an added field is not one.
 */
export const REPORT_SCHEMA_VERSION = 1

/** Machine-readable output for CI gating and diffing between runs. */
export function renderJson(input: ReportInput): string {
	const redactor = input.client.redactor
	return `${JSON.stringify(
		{
			schemaVersion: REPORT_SCHEMA_VERSION,
			...runJson(input),
			findings: input.findings.map((finding) => findingJson(finding, redactor)),
			...contextJson(input, redactor),
			...tallyJson(input),
		},
		null,
		2,
	)}\n`
}
