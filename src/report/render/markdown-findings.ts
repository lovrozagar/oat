import { describeRequestBody, type Exchange } from "../../runtime/exchange.ts"
import type { Finding } from "../../runtime/finding.ts"
import { presentHeader } from "../../runtime/headers.ts"
import type { Redactor } from "../../security/redact.ts"
import { ISSUE_REPRO_DIR, reproStem } from "./repro.ts"
import { formatBytes, truncate } from "./text.ts"
import { byVerdict, findingSubject, VERDICT_LABEL, VERDICT_NOTE } from "./verdicts.ts"

/** Evidence shown per finding; the repro script carries all of it. */
const EVIDENCE_SHOWN = 3

/** A collapsed body, in a fenced JSON block. */
function bodyBlock(summary: string, body: unknown): string[] {
	return ["", `<details><summary>${summary}</summary>`, "", "```json", truncate(body), "```", "", "</details>"]
}

/** One exchange: its request line and timing, then its bodies, collapsed. */
export function exchangeBlock(exchange: Exchange, redactor: Redactor): string[] {
	/* A secret the response issues may sit in the request or URL rendered first. */
	redactor.learn(exchange.responseBody)
	const url = new URL(redactor.url(exchange.url))
	const lines = [
		"",
		`\`${exchange.method} ${url.pathname}${url.search}\` → **${exchange.status}** (${new Date(exchange.at).toISOString()} · ${exchange.durationMs}ms · ${formatBytes(exchange.requestBytes)} → ${formatBytes(exchange.responseBytes)}${exchange.requestId === "" ? "" : ` · ${exchange.requestId}`})`,
	]
	if (exchange.requestBody !== undefined) {
		lines.push(
			...bodyBlock(
				"request body",
				redactor.body(
					describeRequestBody(exchange.requestBody),
					presentHeader(exchange.requestHeaders, "content-type") ?? "",
				),
			),
		)
	}
	if (exchange.responseBody !== null && exchange.responseBody !== undefined) {
		lines.push(
			...bodyBlock(
				"response body",
				redactor.body(exchange.responseBody, presentHeader(exchange.responseHeaders, "content-type") ?? ""),
			),
		)
	}
	return lines
}

function findingSection(finding: Finding, redactor: Redactor): string[] {
	const lines = [`### ${findingSubject(finding)} — ${finding.summary}`, "", `\`${finding.check}\``, "", finding.detail]
	for (const exchange of finding.evidence.slice(0, EVIDENCE_SHOWN)) lines.push(...exchangeBlock(exchange, redactor))
	if (finding.evidence.length > 0) {
		lines.push("")
		lines.push(`Reproduce: \`${ISSUE_REPRO_DIR}/${reproStem(finding)}.sh\``)
	}
	lines.push("")
	return lines
}

/** A section per severity, most severe first: each finding with its evidence and its repro script. */
export function findingSections(findings: readonly Finding[], redactor: Redactor): string[] {
	const lines: string[] = []
	for (const [findingVerdict, group] of byVerdict(findings)) {
		lines.push(`## ${VERDICT_LABEL[findingVerdict]}`)
		lines.push("")
		lines.push(`> ${VERDICT_NOTE[findingVerdict]}`)
		lines.push("")
		for (const finding of group) lines.push(...findingSection(finding, redactor))
	}
	return lines
}
