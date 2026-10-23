/**
 * The run as JUnit XML, for CI tools that gate on test results. There is no official schema; this
 * writes the common denominator of Jenkins' xunit `junit-10.xsd`, GitLab and Testmo:
 * - a suite per entity (`operations` for one with none, `<origin>:<entity>` on a secondary origin);
 * - a case per (operation, check): passed, a failure for a failing root cause, or skipped for a
 *   known finding, a coverage gap, an inconclusive check or a blocked one, each check once;
 * - an `oat.run` suite for findings no operation case holds, and for a run that failed or may have
 *   left records behind, so the JUnit outcome agrees with the exit code.
 * Every text and attribute goes through the run's redactor, then XML escaping. No CDATA is used.
 */

import type { Exchange } from "../../runtime/exchange.ts"
import { runVerdict } from "../../runtime/exit.ts"
import { type Finding, isFailingRootCause, isRootCause } from "../../runtime/finding.ts"
import type { OperationCoverage } from "../../runtime/scope/types.ts"
import type { Redactor } from "../../security/redact.ts"
import type { ReportInput } from "./input.ts"

type Result =
	| { kind: "passed" }
	| { kind: "failure"; type: string; message: string; body: string }
	| { kind: "skipped"; message: string }
	| { kind: "error"; type: string; message: string }

interface Case {
	classname: string
	name: string
	result: Result
}

const RUN_SUITE = "oat.run"
const RUN_CLASS = "run"
const EVIDENCE_LINES = 5

/* An operation's checks, the first kind a check appears under winning: GitLab keeps only the first duplicate. */
const PRECEDENCE = ["failed", "gaps", "inconclusive", "suppressed", "passed"] as const

/*
 * What XML 1.0 forbids anywhere, escaped or not: C0 controls other than tab, newline and carriage
 * return, U+FFFE, U+FFFF, and a surrogate half with no partner.
 */
// oxlint-disable-next-line no-control-regex -- these are the characters XML forbids
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u{FFFE}\u{FFFF}]|\p{Cs}/gu

const ESCAPES: Record<string, string> = {
	"\t": "&#9;",
	"\n": "&#10;",
	"\r": "&#13;",
	'"': "&quot;",
	"&": "&amp;",
	"'": "&apos;",
	"<": "&lt;",
	">": "&gt;",
}

/* Text content keeps its tabs and newlines; a carriage return is escaped so a parser does not fold it. */
function text(value: string): string {
	return value.replace(XML_INVALID, "").replace(/[&<>"'\r]/g, (c) => ESCAPES[c] as string)
}

/* An attribute value keeps every whitespace character a parser would otherwise normalize to a space. */
function attr(value: string): string {
	return value.replace(XML_INVALID, "").replace(/[&<>"'\t\n\r]/g, (c) => ESCAPES[c] as string)
}

function suiteName(op: OperationCoverage): string {
	const entity = op.entity ?? "operations"
	return op.origin === undefined ? entity : `${op.origin}:${entity}`
}

function className(op: OperationCoverage): string {
	return op.origin === undefined ? op.operationId : `${op.origin}:${op.operationId}`
}

function evidenceLine(exchange: Exchange, redactor: Redactor): string {
	return `${exchange.method} ${redactor.url(exchange.url)} → ${exchange.status}`
}

/* A finding's detail, then the first exchanges that prove it. */
function bodyOf(finding: Finding, redactor: Redactor): string {
	const lines = [finding.detail, ...finding.evidence.slice(0, EVIDENCE_LINES).map((e) => evidenceLine(e, redactor))]
	const more = finding.evidence.length - EVIDENCE_LINES
	if (more > 0) lines.push(`… ${more} more exchanges in oat-report.json`)
	return lines.join("\n")
}

/* Why a finding that does not fail the run is still worth a line. */
function excuse(finding: Finding): string {
	if (finding.known !== undefined) return `known (baseline): ${finding.known.reason}`
	return finding.verdict === "COVERAGE_GAP" ? `coverage gap: ${finding.summary}` : `blocked: ${finding.summary}`
}

/* One case standing for `findings`: a failure when any fails the run, else skipped with every excuse once. */
function judged(findings: readonly Finding[], redactor: Redactor): Result {
	const failing = findings.filter(isFailingRootCause)
	const first = failing[0]
	if (first !== undefined) {
		const body = failing.map((finding) => bodyOf(finding, redactor)).join("\n\n")
		return { body, kind: "failure", message: first.summary, type: first.verdict }
	}
	if (findings.length === 0)
		return { body: "", kind: "failure", message: "no finding names this check", type: "failed" }
	return { kind: "skipped", message: [...new Set(findings.map(excuse))].join("; ") }
}

/** Builds the cases, remembering which findings a case already holds. */
class Cases {
	readonly suites = new Map<string, Case[]>()
	readonly placed = new Set<Finding>()
	readonly #input: ReportInput

	constructor(input: ReportInput) {
		this.#input = input
	}

	add(suite: string, entry: Case): void {
		const list = this.suites.get(suite) ?? []
		list.push(entry)
		this.suites.set(suite, list)
	}

	/* The findings an operation's case for `check` stands for: that check, on that operation, from that origin. */
	#findingsOn(op: OperationCoverage, check: string): Finding[] {
		return this.#input.findings.filter(
			(f) => f.check === check && f.origin === op.origin && f.operations?.includes(op.operationId) === true,
		)
	}

	#result(op: OperationCoverage, kind: (typeof PRECEDENCE)[number], check: string): Result {
		const input = this.#input
		const suite = suiteName(op)
		if (kind === "passed") return { kind: "passed" }
		if (kind === "failed") {
			const causes = this.#findingsOn(op, check).filter(isRootCause)
			for (const cause of causes) this.placed.add(cause)
			return judged(causes, input.client.redactor)
		}
		if (kind === "gaps") {
			const gap = this.#findingsOn(op, check).find((f) => f.verdict === "COVERAGE_GAP")
			return { kind: "skipped", message: gap === undefined ? "coverage gap" : `coverage gap: ${gap.summary}` }
		}
		if (kind === "inconclusive") {
			/* A secondary origin's entries come back under its prefixed entity, not by operation. */
			const entries = input.inconclusive ?? []
			const entry = entries.find(
				(i) =>
					i.check === check &&
					(op.origin === undefined ? i.operations?.includes(op.operationId) === true : i.entity === suite),
			)
			return { kind: "skipped", message: entry === undefined ? "inconclusive" : `inconclusive: ${entry.reason}` }
		}
		const waiting = (input.checksSuppressed ?? []).find((s) => s.check === check && s.entity === suite)
		return { kind: "skipped", message: `blocked: waiting on ${waiting?.because ?? "an earlier failure"}` }
	}

	operation(op: OperationCoverage): void {
		const seen = new Set<string>()
		const classname = className(op)
		for (const kind of PRECEDENCE) {
			for (const check of op.checks[kind]) {
				if (seen.has(check)) continue
				seen.add(check)
				this.add(suiteName(op), { classname, name: check, result: this.#result(op, kind, check) })
			}
		}
		if (seen.size === 0)
			this.add(suiteName(op), {
				classname,
				name: "graded",
				result: { kind: "skipped", message: op.reason ?? op.status },
			})
	}

	standDowns(): void {
		const seen = new Set<string>()
		for (const { check, entity, needs } of this.#input.checksSkipped ?? []) {
			const key = `${entity}\0${check}`
			if (seen.has(key)) continue
			seen.add(key)
			this.add(entity, { classname: entity, name: check, result: { kind: "skipped", message: `stood down: ${needs}` } })
		}
	}

	/* Run-level findings, and root causes no operation case holds: the exit code counts them all. */
	run(): void {
		const byCheck = new Map<string, Finding[]>()
		for (const finding of this.#input.findings) {
			if (this.placed.has(finding)) continue
			if (finding.operations !== undefined && !isRootCause(finding)) continue
			byCheck.set(finding.check, [...(byCheck.get(finding.check) ?? []), finding])
		}
		const redactor = this.#input.client.redactor
		for (const [check, findings] of byCheck)
			this.add(RUN_SUITE, { classname: RUN_CLASS, name: check, result: judged(findings, redactor) })
		const { outcome, reason } = runVerdict(this.#input)
		if (outcome === "failed" || outcome === "leftovers")
			this.add(RUN_SUITE, {
				classname: RUN_CLASS,
				name: "outcome",
				result: { kind: "error", message: reason, type: outcome },
			})
	}
}

function count(cases: readonly Case[], kind: Result["kind"]): number {
	return cases.filter((c) => c.result.kind === kind).length
}

function caseXml(entry: Case, redactor: Redactor): string {
	const said = (value: string): string => attr(redactor.text(value))
	const head = `    <testcase classname="${said(entry.classname)}" name="${said(entry.name)}"`
	const { result } = entry
	switch (result.kind) {
		case "passed":
			return `${head}/>`
		case "skipped":
			return `${head}><skipped message="${said(result.message)}"/></testcase>`
		case "error":
			return `${head}><error type="${said(result.type)}" message="${said(result.message)}"/></testcase>`
		case "failure":
			return (
				`${head}><failure type="${said(result.type)}" message="${said(result.message)}">` +
				`${text(redactor.text(result.body))}</failure></testcase>`
			)
	}
}

/** The run as `junit.xml`. */
export function renderJunit(input: ReportInput): string {
	const cases = new Cases(input)
	for (const op of input.scope?.operations ?? []) cases.operation(op)
	cases.standDowns()
	cases.run()
	const redactor = input.client.redactor
	const timestamp = input.startedAt.toISOString().replace(/\.\d{3}Z$/, "Z")
	const suites = [...cases.suites].sort(([a], [b]) => a.localeCompare(b))
	const all = suites.flatMap(([, list]) => list)
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="oat" tests="${all.length}" failures="${count(all, "failure")}" errors="${count(all, "error")}"` +
			` time="${(input.durationMs / 1000).toFixed(3)}">`,
	]
	for (const [name, list] of suites) {
		list.sort((a, b) => a.classname.localeCompare(b.classname) || a.name.localeCompare(b.name))
		lines.push(
			`  <testsuite name="${attr(redactor.text(name))}" tests="${list.length}" failures="${count(list, "failure")}"` +
				` errors="${count(list, "error")}" skipped="${count(list, "skipped")}" timestamp="${timestamp}">`,
			...list.map((entry) => caseXml(entry, redactor)),
			"  </testsuite>",
		)
	}
	lines.push("</testsuites>")
	return `${lines.join("\n")}\n`
}
